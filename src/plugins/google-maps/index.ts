/**
 * plugins/google-maps/index.ts — Hybrid Serper.dev API + Playwright Fallback
 *
 * Flow: Keyword -> Serper.dev API -> filter incomplete -> Playwright fallback -> normalize -> save
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
  ProviderError,
  ProviderErrorType,
  checkCircuitBreaker,
  recordFailure,
  recordSuccess,
} from "@compx/scraper-core";
import type { PluginContext, PluginResult, SourcePlugin } from "@compx/scraper-core";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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

async function fetchFromSerper(query: string, maxResults: number, logger: ReturnType<typeof createLogger>, redis: any) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) throw new Error("SERPER_API_KEY is not set in environment");

  const cbState = await checkCircuitBreaker("serper", redis);
  if (cbState === "OPEN") {
    throw new ProviderError(ProviderErrorType.CIRCUIT_OPEN, "Serper Circuit is OPEN");
  }

  const allResults: any[] = [];
  let page = 1;
  const maxRetries = 2;

  while (allResults.length < maxResults) {
    await logger.log(`Fetching from Serper.dev (page=${page})...`);
    
    let success = false;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        const res = await fetch('https://google.serper.dev/places', {
          method: 'POST',
          headers: {
            'X-API-KEY': apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ q: query, page }),
          signal: AbortSignal.timeout(10000)
        });

        if (res.status >= 500 || res.status === 429) {
          throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json();
        
        if (data.message && data.statusCode) {
          throw new Error(data.message);
        }

        const places = data.places || [];
        allResults.push(...places);
        
        await recordSuccess("serper", redis);
        success = true;
        break; 
      } catch (err: any) {
        await logger.log(`Serper API fetch failed (attempt ${attempt}): ${err.message}`);
        if (attempt <= maxRetries) {
          const delay = Math.pow(2, attempt - 1) * 1000; // Exponential backoff: 1s, 2s
          await sleep(delay);
        } else {
          await recordFailure("serper", redis);
          throw new Error("Serper request failed after retries");
        }
      }
    }
    
    if (!success || allResults.length >= maxResults) break;
    
    page++;
    await sleep(1000);
  }

  return allResults.slice(0, maxResults);
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
    // 1. Fetch via API
    const apiResults = await fetchFromSerper(query, maxResults, logger, ctx.redis);
    await logger.log(`Found ${apiResults.length} business listing(s) via Serper API.`);

    try {
      for (let i = 0; i < apiResults.length; i++) {
        const apiItem = apiResults[i];
      let detail: Record<string, any> = {
        name: apiItem.title,
        company: apiItem.title,
        website: apiItem.website || null,
        phone: apiItem.phoneNumber || null, // Serper uses phoneNumber
        address: apiItem.address || null,
        placeId: apiItem.cid || null, // Storing CID as placeId for reference
        email: null,
        source: "google_maps",
      };

      // Fallback is removed per user request for pure Serper -> JSON -> Website Queue flow

      const validation = validateLead(detail);
      if (validation.valid) {
        results.push(detail);
      } else {
        await logger.log(`  skipped ${detail.name}: ${validation.reasons.join(", ")}`);
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
