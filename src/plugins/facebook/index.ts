/**
 * plugins/facebook/index.ts — 3-Provider Fallback Chain
 *
 * Provider order (Facebook):
 *   1. Apify (primary)          — apify/facebook-pages-scraper actor, richest data
 *   2. SerpApi (fallback)       — Google search → Facebook page URL list
 *   3. Own page-scraper (fallback) — anonymous browser scraping of /about pages
 *
 * No login required. All browser work uses anonymous context + residential proxy.
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
  getBrowserPool,
  ProviderError,
  ProviderErrorType,
} from "@compx/scraper-core";
import type { PluginContext, PluginResult, SourcePlugin } from "@compx/scraper-core";

import { discoverFacebookPagesViaApify } from "./providers/apify.js";
import { discoverFacebookPagesViaSerpApi, type FacebookPageStub } from "./providers/serpapi.js";
import { scrapePublicFacebookPages, type FacebookPageData } from "./providers/page-scraper.js";

// ─── Supabase ─────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
  { realtime: { transport: ws as any } }
);

const DEFAULT_MAX_RESULTS = 10;

interface FacebookInput {
  keyword?: string;
  location?: string;
  enrichments?: Record<string, boolean>;
  maxResults?: number;
}

// ─── Merge stub (SerpAPI/Apify) + deep data (page scraper) into a lead record ─
function buildLeadRecord(
  stub: FacebookPageStub,
  deep: FacebookPageData | null
): Record<string, any> {
  // Deep data wins over snippet data wherever available
  return {
    source: "facebook",
    name: deep?.name || stub.name,
    company: deep?.name || stub.name,
    phone: deep?.phone || stub.phone || null,
    email: deep?.email || null,
    website: deep?.website || stub.website || null,
    about: deep?.about || stub.about || null,
    address: deep?.address || null,
    category: deep?.category || stub.category || null,
    rating: deep?.rating || null,
    review_count: deep?.reviewCount || null,
    followers_count: deep?.followersCount || stub.followersCount || null,
    facebook: stub.pageUrl,
    extra_data: {
      page_name: stub.name,
      facebook_url: stub.pageUrl,
      followers_count: deep?.followersCount || stub.followersCount,
      category: deep?.category || stub.category,
      rating: deep?.rating,
    },
  };
}

// ─── Main plugin run ──────────────────────────────────────────────────────────
async function run(ctx: PluginContext): Promise<PluginResult> {
  const input = ctx.input as FacebookInput;
  const logger = createLogger(ctx.jobId);

  // ── Plan Gate ─────────────────────────────────────────────────
  const access = await checkSourceAccess(supabase, "facebook", ctx.userId, ctx.orgId);
  if (!access.allowed) {
    await logger.log(`Blocked: facebook not available on ${access.planName} plan.`);
    await logger.close();
    return {
      leads_found: 0, saved: 0, errors: 0, blocked: true,
      message: `Facebook isn't available on your current plan.` +
        (access.requiredTier ? ` Upgrade to ${access.requiredTier}.` : ""),
    };
  }

  if (!input.keyword) {
    await logger.log("No keyword provided — aborting.");
    await logger.close();
    return { leads_found: 0, saved: 0, errors: 1 };
  }

  const activeEnrichments = Object.keys(input.enrichments || {}).filter(k => (input.enrichments as any)[k]);
  const maxResults = Number.isFinite(input.maxResults) && (input.maxResults as number) > 0
    ? Math.floor(input.maxResults as number)
    : DEFAULT_MAX_RESULTS;

  // ── Cache Check ───────────────────────────────────────────────
  const cacheKey = `fb:${input.keyword}:${input.location || ""}`;
  const cacheHit = await getCachedScrape(supabase, "facebook", cacheKey, "v2", logger);

  let results: Record<string, any>[] = [];

  if (cacheHit.hit && cacheHit.data) {
    await logger.log(`Cache hit for "${input.keyword}" — skipping discovery.`);
    results = cacheHit.data;
  } else {

    // ══════════════════════════════════════════════════════════════════════════
    // PROVIDER 1: Apify (PRIMARY)
    // ══════════════════════════════════════════════════════════════════════════
    if (process.env.APIFY_API_TOKEN) {
      try {
        await logger.log(`🚀 [Provider 1] Apify — primary discovery for "${input.keyword}" ${input.location || ""}...`);
        const apifyResults = await discoverFacebookPagesViaApify({
          keyword: input.keyword,
          location: input.location,
          maxResults,
        });
        await logger.log(`✅ [Provider 1] Apify returned ${apifyResults.length} pages`);
        results = apifyResults.map(({ stub, deep }) => buildLeadRecord(stub, deep));
      } catch (err: any) {
        await logger.log(`⚠️ [Provider 1] Apify failed: ${err.message} — falling back to SerpApi`);
      }
    } else {
      await logger.log("⚠️ [Provider 1] APIFY_API_TOKEN not set — skipping Apify");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PROVIDER 2: SerpApi + own page-scraper (FALLBACK)
    // ══════════════════════════════════════════════════════════════════════════
    if (results.length === 0) {
      let stubs: FacebookPageStub[] = [];

      if (process.env.SERPAPI_API_KEY) {
        try {
          await logger.log(`🌐 [Provider 2] SerpApi — discovery fallback for "${input.keyword}"...`);
          stubs = await discoverFacebookPagesViaSerpApi({
            keyword: input.keyword,
            location: input.location,
            maxResults,
          });
          await logger.log(`✅ [Provider 2] SerpApi found ${stubs.length} Facebook page URLs`);
        } catch (err: any) {
          await logger.log(`⚠️ [Provider 2] SerpApi failed: ${err.message} — will try own browser scraper`);
        }
      } else {
        await logger.log("⚠️ [Provider 2] SERPAPI_API_KEY not set — skipping SerpApi");
      }

      // Enrich stubs with browser page-scraper
      if (stubs.length > 0) {
        const pageUrls = stubs.map(s => s.pageUrl);
        const deepDataMap = new Map<string, FacebookPageData>();

        try {
          await logger.log(`🔬 [Provider 2] Page-scraper enriching ${pageUrls.length} pages...`);

          const pool = getBrowserPool();
          const poolLease = await pool.acquireContext({});
          const browser = (poolLease as any).context.browser();

          try {
            const deepResults = await scrapePublicFacebookPages(browser, pageUrls, {
              proxy: (ctx as any).proxy ?? null,
              maxPages: maxResults,
              onProgress: async (done, total, data) => {
                await logger.log(
                  `📊 [Provider 2] ${done}/${total}: ${data.name} — ` +
                  `${data.phone ? "📞 " + data.phone : "no phone"} | ` +
                  `${data.email ? "✉️ " + data.email : "no email"} | ` +
                  `${data.website ? "🌐 " + data.website : "no website"}`
                );
              },
            });

            for (const d of deepResults) {
              deepDataMap.set(d.pageUrl, d);
            }
            await logger.log(`✅ [Provider 2] Page-scraper enriched ${deepResults.length} pages`);
          } finally {
            await poolLease.release().catch(() => {});
          }
        } catch (err: any) {
          await logger.log(`⚠️ [Provider 2] Page-scraper failed: ${err.message} — using SerpApi stubs only`);
        }

        for (const stub of stubs) {
          const deep = deepDataMap.get(stub.pageUrl) || null;
          results.push(buildLeadRecord(stub, deep));
        }
        await logger.log(`✅ [Provider 2] Built ${results.length} lead records`);
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PROVIDER 3: Own browser scraper direct search (LAST RESORT)
    // ══════════════════════════════════════════════════════════════════════════
    if (results.length === 0) {
      await logger.log(`🔬 [Provider 3] All API providers failed — using own browser scraper directly...`);
      try {
        const pool = getBrowserPool();
        const poolLease = await pool.acquireContext({});
        const browser = (poolLease as any).context.browser();

        // Search URL for Facebook pages directly
        const searchQuery = input.location
          ? `${input.keyword} ${input.location}`
          : input.keyword;
        const searchUrl = `https://www.facebook.com/search/pages/?q=${encodeURIComponent(searchQuery)}`;

        try {
          const deepResults = await scrapePublicFacebookPages(browser, [searchUrl], {
            proxy: (ctx as any).proxy ?? null,
            maxPages: maxResults,
            onProgress: async (done, total, data) => {
              await logger.log(`📊 [Provider 3] ${done}/${total}: ${data.name}`);
            },
          });

          for (const d of deepResults) {
            const stub: FacebookPageStub = {
              pageUrl: d.pageUrl,
              pageSlug: d.pageSlug,
              name: d.name,
              about: d.about || "",
              followersCount: d.followersCount,
              category: d.category,
              website: d.website,
              phone: d.phone,
            };
            results.push(buildLeadRecord(stub, d));
          }
          await logger.log(`✅ [Provider 3] Own scraper found ${results.length} pages`);
        } finally {
          await poolLease.release().catch(() => {});
        }
      } catch (err: any) {
        await logger.log(`❌ [Provider 3] Own scraper also failed: ${err.message}`);
        await logger.close();
        return { leads_found: 0, saved: 0, errors: 1 };
      }
    }

    await logger.log(`📋 Total leads built: ${results.length}`);

    if (results.length > 0) {
      await setCachedScrape(supabase, "facebook", cacheKey, results, "v2");
    }
  }

  // Enforce maxResults
  if (results.length > maxResults) {
    results = results.slice(0, maxResults);
  }

  // ── Save Leads ─────────────────────────────────────────────
  const uploadResult = await saveLeads(
    supabase, results, ctx.userId, ctx.orgId,
    (item, userId, orgId) => baseRowMapper(item, userId, orgId, "facebook")
  );

  // ── Enrichment Dispatch ────────────────────────────────────
  for (const item of results) {
    if (item.website && activeEnrichments.includes("website") && ctx.dispatchEnrichment) {
      await ctx.dispatchEnrichment("website", { domain: item.website });
    }
  }
  if (activeEnrichments.includes("ai") && ctx.dispatchEnrichment) {
    for (const leadId of uploadResult.savedIds) {
      await ctx.dispatchEnrichment("ai", { leadId });
    }
  }

  // ── Charge on Success ──────────────────────────────────────
  if (uploadResult.saved > 0) {
    const costPerLead = calculateLeadCost("facebook", { isCacheHit: cacheHit.hit, enrichments: [] });
    const totalCost = costPerLead * uploadResult.saved;
    const chargeResult = await chargeBatchForLeads(supabase, ctx.userId, ctx.orgId, totalCost);
    if (!chargeResult.charged) {
      console.error(`[Facebook] Failed to charge ${totalCost} credits: ${chargeResult.reason}`);
    }
  }

  await logger.close();

  return {
    leads_found: results.length,
    saved: uploadResult.saved,
    errors: uploadResult.errors,
  };
}

export const facebookPlugin: SourcePlugin = {
  name: "facebook",
  requiresBrowser: true,
  run,
};
