/**
 * plugins/youtube/index.ts — Phase 1 Final Spec: API-first approach
 *
 * Flow:
 * 1. search.list (only if keyword search)
 * 2. channels.list (batch 50)
 * 3. About Page (No Browser) -> ytInitialData
 * 4. lead-enrichment queue (kind=website, kind=ai)
 */

import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import {
  fetchPage,
  getBrowserPool,
  getProxyManager,
  analyzeJobRisk,
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

interface YoutubeInput {
  keyword?: string;
  channelUrls?: string[];
  enrichments?: any;
}

function extractYtInitialData(html: string): any | null {
  const m = html.match(/var ytInitialData\s*=\s*(\{.*?\});<\/script>/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

async function scrapeViaFetch(channelId: string, channelUrl: string): Promise<Record<string, any> | null> {
  const aboutUrl = `https://www.youtube.com/channel/${channelId}/about`;
  const page = await fetchPage(aboutUrl);
  if (!page.ok) return null;

  const initialData = extractYtInitialData(page.html);
  if (!initialData) return null;

  const metadata = initialData?.metadata?.channelMetadataRenderer;
  if (!metadata) return null;

  const parsed: Record<string, any> = {
    website: metadata.ownerUrls?.find((u: string) => !u.includes("youtube.com")) || null,
    instagram: metadata.ownerUrls?.find((u: string) => u.includes("instagram.com")) || null,
    facebook: metadata.ownerUrls?.find((u: string) => u.includes("facebook.com")) || null,
    twitter: metadata.ownerUrls?.find((u: string) => u.includes("twitter.com") || u.includes("x.com")) || null,
    tiktok: metadata.ownerUrls?.find((u: string) => u.includes("tiktok.com")) || null,
  };

  const text = htmlToText(page.html);
  const emails = extractEmailsFromText(text);
  if (emails[0]) parsed.email = emails[0];

  return parsed;
}

async function scrapeViaBrowser(channelId: string, proxyServer?: string | null): Promise<Record<string, any> | null> {
  const pool = getBrowserPool();
  const lease = await pool.acquireContext(proxyServer ? { proxy: { server: proxyServer } } : {});

  try {
    const page = await lease.context.newPage();
    await page.goto(`https://www.youtube.com/channel/${channelId}/about`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForTimeout(1500);

    const bodyText = htmlToText(await page.content());
    const emails = extractEmailsFromText(bodyText);

    return {
      email: emails[0] || null,
    };
  } finally {
    await lease.release();
  }
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

  // ── Cache Check (Idempotent) ──────────────────────────────────────────────
  const activeEnrichments = Object.keys(input.enrichments || {}).filter(k => input.enrichments[k]);
  const cacheKeyTarget = input.keyword ? `search:${input.keyword}` : `urls:${input.channelUrls?.join(",")}`;
  const cacheHit = await getCachedScrape(supabase, "youtube", cacheKeyTarget, "v1", logger);

  let results: Record<string, any>[] = [];
  
  if (cacheHit.hit && cacheHit.data) {
    results = cacheHit.data;
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
        let aboutData = await scrapeViaFetch(channelId, record.channelUrl);
        if (aboutData) {
          await logger.log(`✓ ${record.channelName} (fetch)`);
          record = { ...record, ...aboutData };
        } else {
          await logger.log(`  fetch parse failed for ${record.channelName} — falling back to browser`);
          aboutData = await scrapeViaBrowser(channelId, proxy?.server);
          if (aboutData) {
            await logger.log(`✓ ${record.channelName} (browser fallback)`);
            record = { ...record, ...aboutData };
          }
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
