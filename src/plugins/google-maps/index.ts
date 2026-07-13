/**
 * plugins/google-maps/index.ts — Serper.dev API (via provider router)
 *
 * Flow: Keyword -> Router -> Provider (Serper.dev) -> filter incomplete -> normalize -> save
 *
 * FIX: the docstring here previously said "Hybrid Serper.dev API +
 * Playwright Fallback", but the fallback was removed (see the plugin's
 * `requiresBrowser: false` below) and never actually ran — a stale
 * comment left over from a design that was cut. Corrected to describe
 * what actually executes today. If a Playwright fallback provider is
 * built later, add it to capabilityRegistry's "google_maps" provider list
 * — the router will pick it up with no other change here.
 */

import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import {
  createLogger,
  validateLead,
  saveLeads,
  baseRowMapper,
  extractEmailsFromText,
  htmlToText,
  checkSourceAccess,
  chargeBatchForLeads,
  calculateLeadCost,
  getCachedScrape,
  setCachedScrape,
} from "@compx/scraper-core";
import type { PluginContext, PluginResult, SourcePlugin } from "@compx/scraper-core";
import { googleMapsRouter } from "./router.js";

// FIX: Serper's `website` field for a listing is sometimes a large aggregator/
// locator page (e.g. DHL's service-point locator, `locator.dhl.com/results?address=id:...`)
// rather than the actual business's own site. These are almost always JS-driven
// locator apps with no contact email on them, and the same handful of domains
// repeat across many listings — so every one of them was still passing the
// "!detail.website" check (the field wasn't empty, just wrong) and getting sent
// straight to Firecrawl instead of the cheaper keyword-based discovery fallback.
// Known aggregator/locator domains — extend this list as new false positives show up.
const AGGREGATOR_DOMAINS = [
  "locator.dhl.com",
  "mydhl.express.dhl",
  "maps.google.com",
  "facebook.com",
  "instagram.com",
  "yelp.com",
  "yellowpages.com",
];

// Pattern-based catch-all: locator/results pages tend to carry query params like
// `address=id:` or a `/results` path segment, regardless of domain — catches new
// aggregator sites without needing to hardcode every one.
function looksLikeLocatorPage(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.includes("address=id:") || /\/results\??/.test(lower);
}

function isRealBusinessSite(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (AGGREGATOR_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return false;
    if (looksLikeLocatorPage(url)) return false;
    return true;
  } catch {
    return false;
  }
}

// FIX: multinational franchise/branch listings (DHL Express Service Point, FedEx
// Office, UPS Store, etc.) show up as dozens of near-duplicate Google Maps entries
// — one per physical branch — each with no website of its own (their "website" is
// always the parent corporate site, already filtered out above as a locator/generic
// page). Without this check, every branch was queued into the keyword-discovery
// fallback, which just re-finds the same corporate domain over and over and burns
// discovery + enrichment credits for a lead that was never going to have a useful
// local contact. Known megacorp/franchise brand names — extend as new ones show up.
const MEGACORP_BRANDS = [
  "dhl", "fedex", "ups", "usps", "amazon", "ikea", "mcdonald's", "mcdonalds",
  "starbucks", "walmart", "7-eleven", "kfc", "burger king", "subway", "aramex", "tnt",
];

function isMegacorpBranch(name: string | null | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return MEGACORP_BRANDS.some((b) => lower.includes(b));
}

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
  {
    realtime: {
      transport: ws as any,
    },
  }
);

interface GoogleMapsInput {
  keyword: string;
  location?: string;
  country?: string;
  maxResults?: number;
}

async function run(ctx: PluginContext): Promise<PluginResult> {
  const input = ctx.input as GoogleMapsInput;
  const maxResults = input.maxResults ?? 40;
  const logger = createLogger(ctx.jobId);

  // ── Plan gate — check BEFORE any browser/proxy resource is spent ─────────
  const access = await checkSourceAccess(supabase, "google_maps", ctx.userId, ctx.orgId);
  if (!access.allowed) {
    await logger.log(`Blocked: google_maps not available on ${access.planName} plan.`);
    await logger.close();
    return {
      leads_found: 0, saved: 0, errors: 0, blocked: true,
      message: `Google Maps isn't available on your current plan.` +
        (access.requiredTier ? ` Upgrade to ${access.requiredTier}.` : ""),
    };
  }

  const query = input.location ? `${input.keyword} ${input.location}` : input.keyword;
  await logger.log(`Starting hybrid scrape for: "${query}"`);

  // ── Cache Check (Idempotent) ──────────────────────────────────────────────
  const activeEnrichments = Object.keys((input as any).enrichments || {}).filter(k => (input as any).enrichments[k]);
  const cacheHit = await getCachedScrape(supabase, "google_maps", query, "v1", logger);
  
  let results: Record<string, any>[] = [];
  let skippedNoBalance = 0;
  
  if (cacheHit.hit && cacheHit.data) {
    results = cacheHit.data;
    // We already have the results, skip to saving/charging
  } else {
    // 1. Fetch via Router (currently: Serper.dev only, see capabilityRegistry)
    const { data: apiResults, provider } = await googleMapsRouter.fetch(
      { query, maxResults },
      { jobId: ctx.jobId, logger, redis: ctx.redis }
    );
    await logger.log(`Found ${apiResults.length} business listing(s) via provider "${provider}".`);

    try {
      for (let i = 0; i < apiResults.length; i++) {
        const apiItem = apiResults[i];
      const rawWebsite = apiItem.website || null;
      const usableWebsite = isRealBusinessSite(rawWebsite) ? rawWebsite : null;
      let detail: Record<string, any> = {
        name: apiItem.title,
        company: apiItem.title,
        website: usableWebsite,
        phone: apiItem.phoneNumber || null, // Serper uses phoneNumber
        address: apiItem.address || null,
        placeId: apiItem.cid || null, // Storing CID as placeId for reference
        email: null,
        source: "google_maps",
      };
      if (rawWebsite && !usableWebsite) {
        await logger.log(`  ${detail.name}: website "${rawWebsite}" looks like an aggregator/locator page, treating as no-website`);
      }

      // Fallback is removed per user request for pure Serper -> JSON -> Website Queue flow.
      // FIX: "removed" meant Serper's own result is never enriched inline — it did NOT
      // mean leads with no website should be dropped outright. Serper frequently omits
      // `website` for local/franchise listings (e.g. car dealers), which meant every such
      // lead failed validateLead() with "no_email_and_no_website" and was silently skipped
      // before ever reaching the website queue. dispatchEnrichment("website", ...) already
      // supports keyword-based discovery (see website/index.ts's discoverUrlsViaSearch),
      // so route name+location through that instead of only ever dispatching by domain.
      if (!detail.website && activeEnrichments.includes("website") && ctx.dispatchEnrichment && detail.name) {
        if (isMegacorpBranch(detail.name)) {
          await logger.log(`  ${detail.name}: looks like a franchise/megacorp branch, skipping website discovery (would just re-find the corporate site)`);
        } else {
          await ctx.dispatchEnrichment("website", { keyword: detail.name, location: detail.address || undefined });
        }
      }

      const willDiscover = !detail.website && activeEnrichments.includes("website") && !isMegacorpBranch(detail.name);
      const validation = validateLead(detail);
      if (validation.valid) {
        results.push(detail);
      } else {
        await logger.log(`  skipped ${detail.name}: ${validation.reasons.join(", ")} (queued for website discovery: ${willDiscover})`);
      }

      await ctx.updateProgress({ processedCount: i + 1, totalCount: apiResults.length });
    }

      // Save Cache only if we did a live scrape and got results
      if (results.length > 0) {
        await setCachedScrape(supabase, "google_maps", query, results, "v1");
      }
    } catch (err: any) {
      await logger.log(`Fatal error: ${err.message}`);
      throw err;
    } finally {
      await logger.close();
    }
  }

  const uploadResult = await saveLeads(supabase, results, ctx.userId, ctx.orgId, (item, userId, orgId) =>
    baseRowMapper(item, userId, orgId, "google_maps")
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

  // ── Deferred Charging (Charge Only Success) ───────────────────────────────
  if (uploadResult.saved > 0) {
    const costPerLead = calculateLeadCost("google_maps", {
      isCacheHit: cacheHit.hit,
      enrichments: [], // Step-by-step logic
    });
    const totalCost = costPerLead * uploadResult.saved;
    
    const chargeResult = await chargeBatchForLeads(supabase, ctx.userId, ctx.orgId, totalCost);
    if (!chargeResult.charged) {
      await logger.log(`Failed to charge ${totalCost} credits: ${chargeResult.reason}`);
    } else {
      await logger.log(`Successfully charged ${totalCost} credits for ${uploadResult.saved} leads.`);
    }
  }

  return {
    leads_found: results.length,
    saved: uploadResult.saved,
    errors: uploadResult.errors,
    skippedNoBalance,
    emails: results.map((r) => r.email).filter(Boolean),
    phones: results.map((r) => r.phone).filter(Boolean),
  };
}

export const googleMapsPlugin: SourcePlugin = {
  name: "google_maps",
  requiresBrowser: false, // Pure Serper flow
  run,
};
