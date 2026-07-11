/**
 * plugins/facebook/index.ts — SerpApi-Only Architecture
 *
 * Flow: Keyword → SerpApi (site:facebook.com) → Parse → Validate → Normalize → Save → Queue Enrich
 * NO Playwright / browser fallback — Facebook anti-bot is too aggressive.
 * Charge-on-success: credits only deducted when leads are actually saved.
 *
 * FIX (billing/correctness): same maxResults bug found in plugins/amazon
 * and plugins/ebay — `input.maxResults` was never declared or read. Every
 * SerpApi result got saved AND charged for regardless of what the user
 * requested via the Discover page's "Max Results" control.
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
  ProviderErrorType,
} from "@compx/scraper-core";
import type { PluginContext, PluginResult, SourcePlugin } from "@compx/scraper-core";

import { facebookRouter } from "./router.js";
import { parseFacebookSerpResult } from "./parser.js";
import { validateFacebookPage } from "./validator.js";
import { normalizeFacebookPage } from "./normalizer.js";

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
  {
    realtime: {
      transport: ws as any,
    },
  }
);

// FIX: same conservative default used across the other SerpApi plugins.
const DEFAULT_MAX_RESULTS = 10;

interface FacebookInput {
  keyword?: string;
  location?: string;
  enrichments?: Record<string, boolean>;
  maxResults?: number; // FIX: was missing from the type entirely
}

async function run(ctx: PluginContext): Promise<PluginResult> {
  const input = ctx.input as FacebookInput;
  const logger = createLogger(ctx.jobId);

  // ── Plan Gate ────────────────────────────────────────────────
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

  // FIX: same clamp pattern as the other SerpApi plugins.
  const maxResults =
    Number.isFinite(input.maxResults) && (input.maxResults as number) > 0
      ? Math.floor(input.maxResults as number)
      : DEFAULT_MAX_RESULTS;

  // ── Cache Check ──────────────────────────────────────────────
  const cacheKey = `search:${input.keyword}:${input.location || ""}`;
  const cacheHit = await getCachedScrape(supabase, "facebook", cacheKey, "v1", logger);

  let results: Record<string, any>[] = [];

  if (cacheHit.hit && cacheHit.data) {
    await logger.log(`Cache hit for "${input.keyword}" — skipping SerpApi call.`);
    results = cacheHit.data;
  } else {
    // ── SerpApi Discovery ──────────────────────────────────────
    try {
      await logger.log(`Searching SerpApi for Facebook pages: "${input.keyword}" ${input.location || ""}...`);
      const { data: serpData, provider } = await facebookRouter.fetch(
        { keyword: input.keyword, location: input.location },
        { jobId: ctx.jobId, logger, redis: ctx.redis }
      );
      await logger.log(`Facebook data served by provider "${provider}".`);

      for (const item of serpData) {
        const parsed = parseFacebookSerpResult(item);
        if (!parsed) continue;
        const validated = validateFacebookPage(parsed);
        if (!validated) continue;
        const normalized = normalizeFacebookPage(validated);
        results.push(normalized);
      }

      await logger.log(`SerpApi returned ${results.length} valid Facebook pages.`);
    } catch (err: any) {
      if (err instanceof ProviderError) {
        await logger.log(`SerpApi Error [${err.type}]: ${err.message}`);
        // No browser fallback — Facebook is too risky for Playwright
        if (err.type === ProviderErrorType.EMPTY_RESULT) {
          await logger.log("No Facebook pages found. Status: NOT_FOUND.");
        }
      } else {
        await logger.log(`Unexpected error: ${err.message}`);
      }
    }

    if (results.length > 0) {
      await setCachedScrape(supabase, "facebook", cacheKey, results, "v1");
    }
  }

  // FIX: enforce maxResults after both the fresh-fetch and cache-hit paths
  // converge — the only point neither path can bypass.
  if (results.length > maxResults) {
    await logger.log(`Truncating ${results.length} results to requested maxResults=${maxResults}.`);
    results = results.slice(0, maxResults);
  }

  // ── Save Leads ────────────────────────────────────────────────
  const uploadResult = await saveLeads(supabase, results, ctx.userId, ctx.orgId,
    (item, userId, orgId) => baseRowMapper(item, userId, orgId, "facebook")
  );

  // ── Website Enrichment Dispatch (dedup via Redis SETNX) ────────────
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

  // ── Charge-on-Success ──────────────────────────────────────────
  if (uploadResult.saved > 0) {
    const costPerLead = calculateLeadCost("facebook", {
      isCacheHit: cacheHit.hit,
      enrichments: [],
    });
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
  requiresBrowser: false, // SerpApi-only — no browser needed
  run,
};
