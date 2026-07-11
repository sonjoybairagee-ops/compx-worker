/**
 * plugins/tripadvisor/index.ts — API-First SerpApi Integration
 *
 * Flow: Keyword -> SerpApi (Google site:tripadvisor.com) -> Circuit Breaker -> Save -> Queue Review Enrichment
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

import { tripadvisorRouter } from "./router.js";
import { parseTripadvisorSerpApiResult } from "./parser.js";
import { validateTripadvisorProfile } from "./validator.js";
import { normalizeTripadvisorProfile } from "./normalizer.js";

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
  {
    realtime: {
      transport: ws as any,
    },
  }
);

interface TripadvisorInput {
  keyword: string;
  location?: string;
  enrichments?: Record<string, boolean>;
  // FIX: previously not declared or read — the Discover page's
  // Tripadvisor filter panel had zero effect on the actual scrape.
  tripadvisorFilters?: {
    category?: string;
    minRating?: string;
    minReviews?: string;
    priceLevel?: string;
    sortBy?: string;
    hasWebsite?: boolean;
    painPointKeywords?: string;
  };
}

async function run(ctx: PluginContext): Promise<PluginResult> {
  const input = ctx.input as TripadvisorInput;
  const logger = createLogger(ctx.jobId);

  const access = await checkSourceAccess(supabase, "tripadvisor", ctx.userId, ctx.orgId);
  if (!access.allowed) {
    await logger.log(`Blocked: tripadvisor not available on ${access.planName} plan.`);
    await logger.close();
    return {
      leads_found: 0, saved: 0, errors: 0, blocked: true,
      message: `Tripadvisor isn't available on your current plan.` +
        (access.requiredTier ? ` Upgrade to ${access.requiredTier}.` : ""),
    };
  }
  
  // ── Cache Check ──────────────────────────────────────────────
  const cacheKeyTarget = input.location ? `${input.keyword} ${input.location}` : input.keyword;
  const cacheHit = await getCachedScrape(supabase, "tripadvisor", cacheKeyTarget, "v1", logger);

  let results: Record<string, any>[] = [];
  let skippedNoBalance = 0;

  if (cacheHit.hit && cacheHit.data) {
    results = cacheHit.data;
  } else {
    try {
      await logger.log(`Fetching from Tripadvisor via SerpApi for keyword: "${cacheKeyTarget}"...`);
      const { data: apifyData, provider } = await tripadvisorRouter.fetch(
        { keyword: input.keyword, location: input.location, filters: input.tripadvisorFilters },
        { jobId: ctx.jobId, logger, redis: ctx.redis }
      );
      await logger.log(`Tripadvisor data served by provider "${provider}".`);
      
      for (const item of apifyData) {
        const parsed = parseTripadvisorSerpApiResult(item);
        if (parsed) {
          const validated = validateTripadvisorProfile(parsed);
          if (validated) {
            const normalized = normalizeTripadvisorProfile(validated);
            results.push(normalized);
          }
        }
      }
    } catch (err: any) {
      if (err instanceof ProviderError && err.type === "CIRCUIT_OPEN") {
        await logger.log(`Circuit OPEN. Aborting plugin execution.`);
        throw err; // Passed up to delay job
      }
      await logger.log(`SerpApi Tripadvisor Error: ${err.message}`);
      throw err;
    }

    if (results.length > 0) {
      await setCachedScrape(supabase, "tripadvisor", cacheKeyTarget, results, "v1");
    }
  }

  // FIX: field names corrected against the real parser.ts/normalizer.ts —
  // the parsed/normalized Tripadvisor lead shape is:
  //   { name, company, website: null, linkedin: null, tripadvisor, about,
  //     source, extra_data: { rating, reviews } }
  // (rating/reviews live under extra_data, not top-level as first assumed)
  //
  // hasWebsite is DISABLED below — not a field-naming issue: parser.ts
  // explicitly sets website: null at this stage with the comment "Will be
  // found via enrichment". Every result here has no website yet by
  // design (that's a separate downstream enrichment step) — applying
  // this filter now would discard 100% of results, not the businesses
  // without a website. If website-presence filtering is wanted, it needs
  // to run after the enrichment step, not here.
  const tf = input.tripadvisorFilters;
  if (tf && (tf.minRating || tf.minReviews)) {
    const before = results.length;
    results = results.filter((item: any) => {
      const ed = item.extra_data || {};
      if (tf.minRating && Number(ed.rating ?? 0) < Number(tf.minRating)) return false;
      if (tf.minReviews && Number(ed.reviews ?? 0) < Number(tf.minReviews)) return false;
      return true;
    });
    await logger.log(`Rating/review filters applied: ${before} → ${results.length} results.`);
  }
  if (tf?.hasWebsite) {
    await logger.log(`NOTE: hasWebsite filter requested but not enforced here — website isn't populated until the later tripadvisor_review enrichment step, not at discovery time.`);
  }

  const uploadResult = await saveLeads(supabase, results, ctx.userId, ctx.orgId, (item, userId, orgId) =>
    baseRowMapper(item, userId, orgId, "tripadvisor")
  );

  // ── Dispatch Enqueue ──────────────────────────────────────────────
  // We ALWAYS dispatch tripadvisor_review if we found a tripadvisor URL
  // so the background enricher can parse the review/website details.
  if (uploadResult.savedIds.length === results.length) {
    for (let i = 0; i < results.length; i++) {
      const item = results[i];
      const leadId = uploadResult.savedIds[i];
      if (item.tripadvisor && ctx.dispatchEnrichment) {
        await ctx.dispatchEnrichment("tripadvisor_review", { leadId, url: item.tripadvisor, enrichments: input.enrichments });
      }
    }
  } else {
    // Fallback if array lengths mismatch (e.g. some inserts failed)
    await logger.log(`Warning: savedIds length (${uploadResult.savedIds.length}) != results length (${results.length}). Skipping tripadvisor_review enrichment to prevent ID mismatch.`);
  }

  // ── Deferred Charging (Discovery) ──────────────────────────────────
  if (uploadResult.saved > 0) {
    const costPerLead = calculateLeadCost("tripadvisor", {
      isCacheHit: cacheHit.hit,
      enrichments: [], // Charge Discovery (+2) only, enricher charges +2 for review
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

export const tripadvisorPlugin: SourcePlugin = {
  name: "tripadvisor",
  requiresBrowser: false, 
  run,
};
