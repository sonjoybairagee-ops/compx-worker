/**
 * plugins/youtube/index.ts — Phase 1 Final Spec: API-first approach
 *
 * Flow:
 * 1. search.list (only if keyword search)
 * 2. channels.list (batch 50)
 * 3. About Page (No Browser) -> ytInitialData
 * 4. lead-enrichment queue (kind=website, kind=ai)
 *
 * FIX (billing/correctness): same maxResults bug found in the other
 * SerpApi-based plugins (amazon, ebay, facebook, instagram) —
 * `input.maxResults` was never declared or read. Unlike those plugins,
 * this one does real per-channel work after discovery (an About-page
 * fetch, with a Playwright browser fallback on parse failure) for EVERY
 * channel ID found — so on top of the same over-charging problem, this
 * one also wasted real scraping cost (and, worse, browser-pool/proxy
 * usage) processing channels beyond what the user asked for. Fixed by
 * capping `channelIds` before the per-channel loop starts, not just the
 * final `results` array — the channels.list batch call and every
 * about-page fetch/browser-fallback after it now only ever run for the
 * requested count.
 */

import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import {
  getProxyManager,
  analyzeJobRisk,
  createLogger,
  validateLead,
  saveLeads,
  baseRowMapper,
  checkSourceAccess,
  chargeBatchForLeads,
  calculateLeadCost,
  getCachedScrape,
  setCachedScrape,
} from "@compx/scraper-core";
import type { PluginContext, PluginResult, SourcePlugin } from "@compx/scraper-core";
import { youtubeRouter } from "./router.js";

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

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

// FIX: same conservative default used across the other plugins.
const DEFAULT_MAX_RESULTS = 10;

interface YoutubeInput {
  keyword?: string;
  channelUrls?: string[];
  enrichments?: any;
  maxResults?: number; // FIX: was missing from the type entirely
}

async function run(ctx: PluginContext): Promise<PluginResult> {
  const input = ctx.input as YoutubeInput;
  const logger = createLogger(ctx.jobId);

  // ── Plan gate ─────────────────────────────────────────────────────────────
  const access = await checkSourceAccess(supabase, "youtube", ctx.userId, ctx.orgId);
  if (!access.allowed) {
    await logger.log(`Blocked: youtube not available on ${access.planName} plan.`);
    await logger.close();
    return { leads_found: 0, saved: 0, errors: 0, blocked: true, message: "Plan not allowed" };
  }

  if (!YOUTUBE_API_KEY) {
    await logger.log(`Error: YOUTUBE_API_KEY is not configured.`);
    await logger.close();
    throw new Error("YOUTUBE_API_KEY missing");
  }

  // FIX: same clamp pattern as the other plugins.
  const maxResults =
    Number.isFinite(input.maxResults) && (input.maxResults as number) > 0
      ? Math.floor(input.maxResults as number)
      : DEFAULT_MAX_RESULTS;

  // ── Cache Check (Idempotent) ──────────────────────────────────────────────
  const activeEnrichments = Object.keys(input.enrichments || {}).filter(k => input.enrichments[k]);
  const cacheKeyTarget = input.keyword ? `search:${input.keyword}` : `urls:${input.channelUrls?.join(",")}`;
  const cacheHit = await getCachedScrape(supabase, "youtube", cacheKeyTarget, "v1", logger);

  let results: Record<string, any>[] = [];
  
  if (cacheHit.hit && cacheHit.data) {
    // FIX: a cache entry may have been populated by an earlier run that
    // requested more channels than this run did — cap it the same as the
    // fresh-fetch path below so a smaller maxResults on a cache hit isn't
    // silently ignored.
    results = cacheHit.data.slice(0, maxResults);
  } else {
    // 1. Discovery
    let channelIds: string[] = [];
    
    if (input.keyword) {
      await logger.log(`YouTube Discovery: Searching for "${input.keyword}"...`);
      const searchRes = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=50&q=${encodeURIComponent(input.keyword)}&key=${YOUTUBE_API_KEY}`);
      if (searchRes.ok) {
        const searchData = await searchRes.json();
        channelIds = searchData.items?.map((item: any) => item.snippet.channelId) || [];
      } else {
        await logger.log(`Error from YouTube Search API: ${searchRes.statusText}`);
      }
    } else if (input.channelUrls && input.channelUrls.length > 0) {
      // Resolve URLs to channel IDs if possible, for simplicity assuming URLs are already handles/ids 
      // In a real app we might need to resolve `@MrBeast` using another endpoint if needed.
      // For now, we will extract what we can. 
      for (const url of input.channelUrls) {
        const match = url.match(/channel\/(UC[\w-]+)/);
        if (match) channelIds.push(match[1]);
        else {
           // We will fetch search.list for handles if necessary, or just rely on the API.
           const searchRes = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(url)}&key=${YOUTUBE_API_KEY}`);
           if (searchRes.ok) {
             const searchData = await searchRes.json();
             if (searchData.items?.[0]) channelIds.push(searchData.items[0].snippet.channelId);
           }
        }
      }
    }

    // FIX: cap the channel-ID list BEFORE the expensive per-channel work
    // below (channels.list batch call, per-channel About-page fetch, and
    // Playwright browser fallback on parse failure) — not just the final
    // `results` array. Capping only at the end would still fetch/scrape
    // every discovered channel and throw away the excess, burning real
    // API quota, proxy usage, and browser-pool time for nothing.
    if (channelIds.length > maxResults) {
      await logger.log(`Discovered ${channelIds.length} channels — capping to requested maxResults=${maxResults} before per-channel scraping.`);
      channelIds = channelIds.slice(0, maxResults);
    }

    if (channelIds.length === 0) {
      await logger.log(`No channels found.`);
      await logger.close();
      return { leads_found: 0, saved: 0, errors: 0, emails: [] };
    }

    // 2. Batch Details (channels.list)
    await logger.log(`Fetching details for ${channelIds.length} channels...`);
    const detailsRes = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelIds.join(',')}&key=${YOUTUBE_API_KEY}`);
    let channelMap = new Map();
    if (detailsRes.ok) {
      const detailsData = await detailsRes.json();
      for (const item of (detailsData.items || [])) {
        channelMap.set(item.id, {
          channelName: item.snippet.title,
          name: item.snippet.title,
          company: item.snippet.title,
          description: item.snippet.description,
          country: item.snippet.country,
          subscriberCount: item.statistics.subscriberCount,
          channelUrl: item.snippet.customUrl ? `https://youtube.com/${item.snippet.customUrl}` : `https://youtube.com/channel/${item.id}`,
          channelId: item.id,
          source: "youtube"
        });
      }
    }

    const routing = analyzeJobRisk({ source: "youtube", type: "discover_scrape" });
    const proxy = await getProxyManager().getBest(routing);

    let i = 0;
    for (const channelId of channelIds) {
      let record = channelMap.get(channelId);
      if (!record) continue;

      try {
        const { data: aboutResults, provider } = await youtubeRouter.fetch(
          { channelId, channelUrl: record.channelUrl, proxyServer: proxy?.server },
          { jobId: ctx.jobId, logger, redis: ctx.redis }
        );
        const aboutData = aboutResults[0] || null;
        if (aboutData) {
          await logger.log(`✓ ${record.channelName} (${provider})`);
          record = { ...record, ...aboutData };
        }
      } catch (err: any) {
        await logger.log(`✗ ${record.channelName} → ${err.message}`);
      }

      if (record) {
        const validation = validateLead(record);
        if (validation.valid || record.subscriberCount) {
          results.push(record);
        } else {
          await logger.log(`  skipped ${record.channelName}: ${validation.reasons?.join(", ")}`);
        }
      }

      i++;
      await ctx.updateProgress({ processedCount: i, totalCount: channelIds.length });
      await sleep(routing.delayMs);
    }

    if (proxy) await getProxyManager().markSuccess(proxy.id, Date.now());

    if (results.length > 0) {
      await setCachedScrape(supabase, "youtube", cacheKeyTarget, results, "v1");
    }
  }

  await logger.close();

  const uploadResult = await saveLeads(supabase, results, ctx.userId, ctx.orgId, (item, userId, orgId) =>
    baseRowMapper(item, userId, orgId, "youtube")
  );

  // ── Deferred Charging ─────────────────────────────────────────────────────
  if (uploadResult.saved > 0) {
    const costPerLead = calculateLeadCost("youtube", {
      isCacheHit: cacheHit.hit,
      enrichments: activeEnrichments,
    });
    const totalCost = costPerLead * uploadResult.saved;
    const chargeResult = await chargeBatchForLeads(supabase, ctx.userId, ctx.orgId, totalCost);
    if (!chargeResult.charged) {
      console.error(`Failed to charge ${totalCost} credits: ${chargeResult.reason}`);
    }
  }

  // ── Enqueue Lead Enrichments ──────────────────────────────────────────────
  // Website enrichment: dispatched per scraped item (needs domain, not DB id)
  for (const result of results) {
    if (result.website && activeEnrichments.includes("website") && ctx.dispatchEnrichment) {
      await ctx.dispatchEnrichment("website", { domain: result.website });
    }
  }
  // AI enrichment: dispatched using actual DB-generated lead IDs from saveLeads()
  if (activeEnrichments.includes("ai") && ctx.dispatchEnrichment) {
    for (const leadId of uploadResult.savedIds) {
      await ctx.dispatchEnrichment("ai", { leadId });
    }
  }

  return {
    leads_found: results.length,
    saved: uploadResult.saved,
    errors: uploadResult.errors,
    skippedNoBalance: 0,
    emails: results.map((r) => r.email).filter(Boolean),
  };
}

export const youtubePlugin: SourcePlugin = {
  name: "youtube",
  requiresBrowser: false,
  run,
};
