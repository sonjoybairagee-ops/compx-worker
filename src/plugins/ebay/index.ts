/**
 * plugins/ebay/index.ts — API-First SerpApi Integration
 *
 * Flow: Keyword -> SerpApi eBay Engine -> Circuit Breaker -> Normalize -> Save -> Queue Enqueue
 * No Playwright fallback per Final Milestone.
 */

import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import {
  createLogger,
  saveLeads,
  baseRowMapper,
  checkSourceAccess,
  chargeBatchForLeads,
  calculateLeadCost,
  getCachedScrape,
  setCachedScrape,
  ProviderError,
} from "@compx/scraper-core";
import type { PluginContext, PluginResult, SourcePlugin } from "@compx/scraper-core";

import { fetchEbaySerpApi } from "./serpapi.js";
import { parseEbaySerpApiResult } from "./parser.js";
import { validateEbayProfile } from "./validator.js";
import { normalizeEbayProfile } from "./normalizer.js";

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
  {
    realtime: {
      transport: ws as any,
    },
  }
);

interface EbayInput {
  keyword: string;
  enrichments?: Record<string, boolean>;
  // FIX: previously not declared or read at all — the Discover page's
  // eBay filter panel (price, condition, listing type, seller filters,
  // etc.) had zero effect on the actual scrape.
  ebayFilters?: {
    minPrice?: string;
    maxPrice?: string;
    condition?: string;
    ebayDomain?: string;
    listingType?: string;
    sortBy?: string;
    freeShippingOnly?: boolean;
    sellerType?: string; // "any" | "business" | "individual" — NOT currently enforced, see note near the post-filter below (no such data in the parsed SerpApi response)
    topRatedSellerOnly?: boolean; // NOT currently enforced — same reason
    minFeedbackScore?: string;
    minPositiveFeedbackPct?: string;
    minItemsSold?: string;
  };
}

async function run(ctx: PluginContext): Promise<PluginResult> {
  const input = ctx.input as EbayInput;
  const logger = createLogger(ctx.jobId);

  const access = await checkSourceAccess(supabase, "ebay", ctx.userId, ctx.orgId);
  if (!access.allowed) {
    await logger.log(`Blocked: ebay not available on ${access.planName} plan.`);
    await logger.close();
    return {
      leads_found: 0, saved: 0, errors: 0, blocked: true,
      message: `eBay isn't available on your current plan.` +
        (access.requiredTier ? ` Upgrade to ${access.requiredTier}.` : ""),
    };
  }

  const activeEnrichments = Object.keys(input.enrichments || {}).filter(k => (input.enrichments as any)[k]);
  
  // ── Cache Check ──────────────────────────────────────────────
  const cacheKeyTarget = input.keyword;
  const cacheHit = await getCachedScrape(supabase, "ebay", cacheKeyTarget, "v1", logger);

  let results: Record<string, any>[] = [];
  let skippedNoBalance = 0;

  if (cacheHit.hit && cacheHit.data) {
    results = cacheHit.data;
  } else {
    try {
      await logger.log(`Fetching from eBay via SerpApi for keyword: "${input.keyword}"...`);
      const apifyData = await fetchEbaySerpApi(input.keyword, logger, ctx.redis, input.ebayFilters);
      
      for (const item of apifyData) {
        const parsed = parseEbaySerpApiResult(item);
        if (parsed) {
          const validated = validateEbayProfile(parsed);
          if (validated) {
            const normalized = normalizeEbayProfile(validated);
            results.push(normalized);
          }
        }
      }
    } catch (err: any) {
      if (err instanceof ProviderError) {
        if (err.type === "CIRCUIT_OPEN") {
          await logger.log(`Circuit OPEN. Aborting plugin execution.`);
          throw err; // Passed up to index.js to delay job
        }
      }
      await logger.log(`SerpApi eBay Error: ${err.message}`);
      throw err;
    }

    if (results.length > 0) {
      await setCachedScrape(supabase, "ebay", cacheKeyTarget, results, "v1");
    }
  }

  // FIX: field names corrected against the real parser.ts/normalizer.ts
  // (now reviewed) — the parsed/normalized eBay lead shape is:
  //   { name, company, website, address, about, source,
  //     extra_data: { product_title, ebay_url, item_id, price, condition,
  //       category, ships_from, item_sold_count, seller_name,
  //       seller_feedback_score, seller_positive_percent, thumbnail } }
  // Numeric-ish extra_data values may arrive as raw text (e.g.
  // "5,000+ sold", "98.5% positive") since they're extracted from
  // extensions/snippets by parser.ts — strip non-numeric characters
  // before comparing.
  //
  // sellerType and topRatedSellerOnly are DISABLED below — this isn't a
  // field-naming issue, parser.ts confirms SerpApi's eBay response as
  // currently parsed has no seller-type or top-rated-seller data at all.
  // Enforcing these would require either parser.ts extracting more from
  // the raw SerpApi response (if it's even present there — unconfirmed)
  // or an extra per-seller profile lookup (additional API cost). Until
  // then, selecting these in the UI silently does nothing — that's worth
  // fixing on the frontend (grey out / label "coming soon") rather than
  // pretending to filter here.
  const numFrom = (v: unknown): number => {
    if (v == null) return 0;
    const n = parseFloat(String(v).replace(/[^0-9.]/g, ""));
    return isNaN(n) ? 0 : n;
  };

  const f = input.ebayFilters;
  if (f && (f.minFeedbackScore || f.minPositiveFeedbackPct || f.minItemsSold)) {
    const before = results.length;
    results = results.filter((item: any) => {
      const ed = item.extra_data || {};
      if (f.minFeedbackScore && numFrom(ed.seller_feedback_score) < Number(f.minFeedbackScore)) return false;
      if (f.minPositiveFeedbackPct && numFrom(ed.seller_positive_percent) < Number(f.minPositiveFeedbackPct)) return false;
      if (f.minItemsSold && numFrom(ed.item_sold_count) < Number(f.minItemsSold)) return false;
      return true;
    });
    await logger.log(`Seller feedback/sold-count filters applied: ${before} → ${results.length} results.`);
  }
  if (f?.sellerType && f.sellerType !== "any") {
    await logger.log(`NOTE: sellerType filter ("${f.sellerType}") requested but not enforced — SerpApi's eBay response has no seller-type field in the current parser.`);
  }
  if (f?.topRatedSellerOnly) {
    await logger.log(`NOTE: topRatedSellerOnly filter requested but not enforced — no such field in the current parser output.`);
  }

  const uploadResult = await saveLeads(supabase, results, ctx.userId, ctx.orgId, (item, userId, orgId) =>
    baseRowMapper(item, userId, orgId, "ebay")
  );

  // ── Dispatch Enqueue ──────────────────────────────────────────────
  // Website enrichment: dispatched per scraped item (needs domain, not DB id)
  for (const item of results) {
    if (item.website && activeEnrichments.includes("website") && ctx.dispatchEnrichment) {
      await ctx.dispatchEnrichment("website", { domain: item.website });
    }
  }
  // AI enrichment: dispatched using actual DB-generated lead IDs from saveLeads()
  if (activeEnrichments.includes("ai") && ctx.dispatchEnrichment) {
    for (const leadId of uploadResult.savedIds) {
      await ctx.dispatchEnrichment("ai", { leadId });
    }
  }
  // eBay Seller enrichment: dispatched using actual DB-generated lead IDs
  if (activeEnrichments.includes("ebaySeller") && ctx.dispatchEnrichment) {
    for (const leadId of uploadResult.savedIds) {
      await ctx.dispatchEnrichment("ebay_seller", { leadId });
    }
  }

  // ── Deferred Charging (Discovery) ──────────────────────────────────
  if (uploadResult.saved > 0) {
    const costPerLead = calculateLeadCost("ebay", {
      isCacheHit: cacheHit.hit,
      enrichments: [], // Step-by-step logic
    });
    const totalCost = costPerLead * uploadResult.saved;
    const chargeResult = await chargeBatchForLeads(supabase, ctx.userId, ctx.orgId, totalCost);
    if (!chargeResult.charged) {
      console.error(`Failed to charge ${totalCost} credits: ${chargeResult.reason}`);
    }
  }

  await logger.close();

  return {
    leads_found: results.length,
    saved: uploadResult.saved,
    errors: uploadResult.errors,
    skippedNoBalance,
  };
}

export const ebayPlugin: SourcePlugin = {
  name: "ebay",
  requiresBrowser: false, // Pure API Flow now
  run,
};
