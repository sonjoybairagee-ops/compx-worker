import { PuppeteerCrawler } from "@crawlee/puppeteer";
import { supabase } from "../config/supabase.js";
import { getProxyManager } from "@compx/scraper-core";

const PROXY_ROTATION_ENABLED = true;

/**
 * Runs the eBay Seller Verification job.
 * Scrapes the seller profile page to determine if they are a "Business" or "Private" seller.
 */
export async function runEbaySellerEnrichJob(input_data, user_id, job) {
  const leadId = input_data.leadId;
  if (!leadId) throw new Error("ebay_seller enrichment requires a leadId");

  const { data: lead, error: leadErr } = await supabase
    .from("leads")
    .select("extra_data")
    .eq("id", leadId)
    .single();

  if (leadErr || !lead) throw new Error(`Lead not found: ${leadId}`);

  const extra = lead.extra_data || {};
  if (extra.ebay_seller_type) {
    console.log(`[Worker] Skipping eBay seller enrichment for ${leadId} (already completed)`);
    return { skipped: true, reason: "already_enriched" };
  }

  const sellerName = extra.seller_name;
  if (!sellerName) {
    console.warn(`[Worker] Skipping eBay seller enrichment for ${leadId} (no seller_name)`);
    return { skipped: true, reason: "no_seller_name" };
  }

  // Seller profile URL format
  const ebayUrl = `https://www.ebay.com/usr/${encodeURIComponent(sellerName)}`;
  
  let sellerType = "unknown";
  let botBlocked = false;
  let notFound = false;

  const proxyManager = getProxyManager();
  const routing = { type: "discover_scrape", riskLevel: "high" }; // Treat eBay profile as high risk
  const proxy = PROXY_ROTATION_ENABLED ? await proxyManager.getBest(routing) : null;
  const proxyUrl = proxy ? `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}` : undefined;

  const crawler = new PuppeteerCrawler({
    proxyConfiguration: proxyUrl ? new (require("crawlee").ProxyConfiguration)({ proxyUrls: [proxyUrl] }) : undefined,
    requestHandlerTimeoutSecs: 30,
    maxRequestRetries: 2,
    async requestHandler({ page, request, response }) {
      const status = response?.status();
      if (status === 404) {
        notFound = true;
        return;
      }
      
      // Look for CAPTCHA or blocks
      const pageText = await page.evaluate(() => document.body.innerText);
      if (pageText.includes("Verify you are human") || pageText.includes("Pardon Our Interruption")) {
        botBlocked = true;
        throw new Error("Bot protection triggered");
      }

      // eBay specific selector for business seller: usually it's in a box saying "Business seller information"
      // or "Registered as a business seller". In the US/UK, "Business Seller" text is present.
      const isBusiness = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return text.includes("business seller information") || text.includes("registered as a business seller");
      });

      if (isBusiness) {
        sellerType = "business";
      } else {
        sellerType = "individual";
      }
    },
    async failedRequestHandler({ request, error }) {
      console.warn(`[EbaySellerJob] Request failed for ${request.url}: ${error.message}`);
    },
  });

  try {
    await crawler.run([ebayUrl]);
  } catch (err) {
    console.warn(`[EbaySellerJob] Crawler error: ${err.message}`);
  }

  // If attempts are exhausted by BullMQ (this is checking from the `job` object context if provided)
  // Actually, job.attemptsMade === job.opts.attempts is how we check exhaustion, but we need to do it at the wrapper level.
  const attemptsMade = job?.attemptsMade || 0;
  const maxAttempts = job?.opts?.attempts || 3;
  const isFinalAttempt = attemptsMade >= maxAttempts - 1;

  if (botBlocked && !isFinalAttempt) {
    throw new Error("Bot protection triggered. Retrying...");
  }

  if (botBlocked && isFinalAttempt) {
    sellerType = "unknown";
  }
  
  if (notFound) {
    sellerType = "unknown"; // Or maybe "not_found", but let's stick to "unknown" for failure so it doesn't get charged.
  }

  // Only proceed to update if we successfully found it, or if it's a final failure.
  // Wait, if it's "unknown", we don't charge credits (the caller handles charge logic, wait, leadEnrichWorker does).
  // Currently, leadEnrichWorker charges automatically for website/social. But I added ebay_seller to leadEnrichWorker:
  // wait, I didn't add charging for ebay_seller in index.js! Let me fix that.

  const updatedExtra = { ...extra, ebay_seller_type: sellerType };
  
  // Update the database
  const { error: updateErr } = await supabase.rpc("merge_lead_extra_data", {
    p_lead_id: leadId,
    p_patch: { ebay_seller_type: sellerType }
  });

  if (updateErr) {
    // Fallback if RPC doesn't exist yet
    console.warn(`[EbaySellerJob] RPC merge_lead_extra_data failed, falling back to full JSONB replacement:`, updateErr.message);
    const { error: fallbackErr } = await supabase
      .from("leads")
      .update({ extra_data: updatedExtra })
      .eq("id", leadId);
    
    if (fallbackErr) throw new Error(`Fallback DB update failed: ${fallbackErr.message}`);
  }

  // If we couldn't determine the seller type (unknown), we return error so it doesn't get charged?
  // No, if we throw an error, BullMQ retries. If it's a permanent failure (like 404 or final attempt), we shouldn't throw, we should return successfully so it stops retrying, but we must signal not to charge.
  // The charge logic for ebay_seller needs to be explicit: charge only on "business" or "individual" success.
  
  return { sellerType, botBlocked, notFound };
}
