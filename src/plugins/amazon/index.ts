/**
 * plugins/amazon/index.ts — API-First SerpApi Integration
 *
 * Flow: Keyword -> SerpApi Amazon Engine -> Circuit Breaker -> Normalize -> Save -> Queue Enqueue
 * No Playwright fallback per Final Milestone.
 *
 * FIX (billing/correctness): `input.maxResults` was never read anywhere in
 * this file — SerpApi's Amazon engine returns however many organic_results
 * it has for the keyword (48 for a common term like "shoe"), and every one
 * of them got saved AND charged for, regardless of what the user actually
 * requested. A user selecting "Max Results: 10" in the UI was silently
 * billed for the full result count instead. This applies to both the
 * fresh-fetch and cache-hit paths (cache is keyed only by keyword+version,
 * not maxResults, so a prior larger scrape's cached results would also
 * bypass any limit) — the slice below runs after both paths converge, so
 * it's not something a cache hit for a different maxResults value can
 * route around.
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

import { amazonRouter } from "./router.js";
import { parseAmazonSerpApiResult } from "./parser.js";
import { validateAmazonProfile } from "./validator.js";
import { normalizeAmazonProfile } from "./normalizer.js";

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
  {
    realtime: {
      transport: ws as any,
    },
  }
);

// FIX: default kept conservative (matches the smallest tier the UI offers)
// so a request that somehow omits maxResults entirely still can't
// accidentally save/charge for an unbounded batch.
const DEFAULT_MAX_RESULTS = 10;

interface AmazonInput {
  keyword: string;
  enrichments?: Record<string, boolean>;
  maxResults?: number; // FIX: was missing from the type entirely
}

async function run(ctx: PluginContext): Promise<PluginResult> {
  const input = ctx.input as AmazonInput;
  const logger = createLogger(ctx.jobId);

  const access = await checkSourceAccess(supabase, "amazon", ctx.userId, ctx.orgId);
  if (!access.allowed) {
    await logger.log(`Blocked: amazon not available on ${access.planName} plan.`);
    await logger.close();
    return {
      leads_found: 0, saved: 0, errors: 0, blocked: true,
      message: `Amazon isn't available on your current plan.` +
        (access.requiredTier ? ` Upgrade to ${access.requiredTier}.` : ""),
    };
  }

  const activeEnrichments = Object.keys(input.enrichments || {}).filter(k => (input.enrichments as any)[k]);

  // FIX: clamp to a sane positive integer — a bad/negative/zero value from
  // the caller shouldn't silently turn into "no limit" (Number(0) is falsy
  // but `|| DEFAULT` would then apply the default instead of honoring an
  // intentional 0, so check explicitly rather than using `||`).
  const maxResults =
    Number.isFinite(input.maxResults) && (input.maxResults as number) > 0
      ? Math.floor(input.maxResults as number)
      : DEFAULT_MAX_RESULTS;

  // ── Cache Check ──────────────────────────────────────────────
  const cacheKeyTarget = input.keyword;
  const cacheHit = await getCachedScrape(supabase, "amazon", cacheKeyTarget, "v1", logger);

  let results: Record<string, any>[] = [];
  let skippedNoBalance = 0;

  if (cacheHit.hit && cacheHit.data) {
    results = cacheHit.data;
  } else {
    try {
      await logger.log(`Fetching Amazon listings for keyword: "${input.keyword}"...`);
      const { data: apifyData, provider } = await amazonRouter.fetch(
        { keyword: input.keyword },
        { jobId: ctx.jobId, logger, redis: ctx.redis }
      );
      await logger.log(`Amazon data served by provider "${provider}".`);

      for (const item of apifyData) {
        const parsed = parseAmazonSerpApiResult(item);
        if (parsed) {
          const validated = validateAmazonProfile(parsed);
          if (validated) {
            const normalized = normalizeAmazonProfile(validated);
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
      await logger.log(`SerpApi Amazon Error: ${err.message}`);
      throw err;
    }

    if (results.length > 0) {
      await setCachedScrape(supabase, "amazon", cacheKeyTarget, results, "v1");
    }
  }

  // FIX: enforce maxResults here, after both the fresh-fetch and cache-hit
  // paths converge on `results` — this is the only point that can't be
  // bypassed by either path. Everything downstream (save, enrichment
  // dispatch, charging) now only ever sees the slice the user asked for.
  if (results.length > maxResults) {
    await logger.log(`Truncating ${results.length} results to requested maxResults=${maxResults}.`);
    results = results.slice(0, maxResults);
  }

  const uploadResult = await saveLeads(supabase, results, ctx.userId, ctx.orgId, (item, userId, orgId) =>
    baseRowMapper(item, userId, orgId, "amazon")
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

  // ── Deferred Charging (Discovery) ──────────────────────────────────
  if (uploadResult.saved > 0) {
    const costPerLead = calculateLeadCost("amazon", {
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

export const amazonPlugin: SourcePlugin = {
  name: "amazon",
  requiresBrowser: false, // Pure API Flow now
  run,
};
