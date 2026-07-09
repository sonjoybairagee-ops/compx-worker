/**
 * plugins/linkedin/index.ts — Apify Actor Integration
 *
 * Flow: profileUrls -> Apify Actor -> Circuit Breaker -> Normalize -> Save -> Queue Enqueue
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

import { fetchLinkedinApify } from "./apify.js";
import { parseLinkedinApifyResult } from "./parser.js";
import { validateLinkedinProfile } from "./validator.js";
import { normalizeLinkedinProfile } from "./normalizer.js";

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
  {
    realtime: {
      transport: ws as any,
    },
  }
);

interface LinkedinInput {
  profileUrls: string[];
  enrichments?: Record<string, boolean>;
}

async function run(ctx: PluginContext): Promise<PluginResult> {
  const input = ctx.input as LinkedinInput;
  const urls = input.profileUrls || [];
  const logger = createLogger(ctx.jobId);

  const access = await checkSourceAccess(supabase, "linkedin", ctx.userId, ctx.orgId);
  if (!access.allowed) {
    await logger.log(`Blocked: linkedin not available on ${access.planName} plan.`);
    await logger.close();
    return {
      leads_found: 0, saved: 0, errors: 0, blocked: true,
      message: `LinkedIn isn't available on your current plan.` +
        (access.requiredTier ? ` Upgrade to ${access.requiredTier}.` : ""),
    };
  }

  const activeEnrichments = Object.keys(input.enrichments || {}).filter(k => (input.enrichments as any)[k]);
  
  // ── Cache Check ──────────────────────────────────────────────
  const cacheKeyTarget = urls.join(",");
  const cacheHit = await getCachedScrape(supabase, "linkedin", cacheKeyTarget, "v1", logger);

  let results: Record<string, any>[] = [];
  let skippedNoBalance = 0;

  if (cacheHit.hit && cacheHit.data) {
    results = cacheHit.data;
  } else {
    try {
      await logger.log(`Fetching ${urls.length} profile(s) from Apify...`);
      const apifyData = await fetchLinkedinApify(urls, logger, ctx.redis);
      
      for (const item of apifyData) {
        const parsed = parseLinkedinApifyResult(item);
        if (parsed) {
          const validated = validateLinkedinProfile(parsed);
          if (validated) {
            const normalized = normalizeLinkedinProfile(validated);
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
      await logger.log(`Apify Error: ${err.message}`);
      throw err;
    }

    if (results.length > 0) {
      await setCachedScrape(supabase, "linkedin", cacheKeyTarget, results, "v1");
    }
  }

  const uploadResult = await saveLeads(supabase, results, ctx.userId, ctx.orgId, (item, userId, orgId) =>
    baseRowMapper(item, userId, orgId, "linkedin")
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
    const costPerLead = calculateLeadCost("linkedin", {
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

export const linkedinPlugin: SourcePlugin = {
  name: "linkedin",
  requiresBrowser: false, // Pure API Flow now
  run,
};
