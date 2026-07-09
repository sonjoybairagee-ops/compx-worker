/**
 * plugins/amazon/index.ts — API-First SerpApi Integration
 *
 * Flow: Keyword -> SerpApi Amazon Engine -> Circuit Breaker -> Normalize -> Save -> Queue Enqueue
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

import { fetchAmazonSerpApi } from "./serpapi.js";
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

interface AmazonInput {
  keyword: string;
  enrichments?: Record<string, boolean>;
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
  
  // ── Cache Check ──────────────────────────────────────────────
  const cacheKeyTarget = input.keyword;
  const cacheHit = await getCachedScrape(supabase, "amazon", cacheKeyTarget, "v1", logger);

  let results: Record<string, any>[] = [];
  let skippedNoBalance = 0;

  if (cacheHit.hit && cacheHit.data) {
    results = cacheHit.data;
  } else {
    try {
      await logger.log(`Fetching from Amazon via SerpApi for keyword: "${input.keyword}"...`);
      const apifyData = await fetchAmazonSerpApi(input.keyword, logger, ctx.redis);
      
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
