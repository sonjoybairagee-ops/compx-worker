/**
 * plugins/website/index.ts
 *
 * URL discovery (keyword -> candidate URLs via DuckDuckGo) + orchestration
 * (cache, save, charge, enrichment dispatch). The actual per-URL scrape
 * (3-level fetch -> Playwright -> Playwright+proxy fallback) now lives in
 * providers/hybrid-crawler.ts behind the website router — see that file
 * for why it's one composite provider rather than three.
 */

import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import {
  fetchPage,
  validateLead,
  saveLeads,
  baseRowMapper,
  createLogger,
  checkSourceAccess,
  chargeBatchForLeads,
  calculateLeadCost,
  getCachedScrape,
  setCachedScrape,
} from "@compx/scraper-core";
import type { PluginContext, PluginResult, SourcePlugin } from "@compx/scraper-core";
import { websiteRouter } from "./router.js";

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
  {
    realtime: {
      transport: ws as any,
    },
  }
);

interface WebsiteJobInput {
  urls?: string[];
  keyword?: string;
  location?: string;
  maxResults?: number;
}

const EXCLUDED_RESULT_DOMAINS = [
  "facebook.com", "instagram.com", "twitter.com", "x.com", "linkedin.com",
  "youtube.com", "tiktok.com", "pinterest.com", "yelp.com", "tripadvisor.com",
  "wikipedia.org", "google.com", "maps.google.com", "amazon.com",
  "indeed.com", "glassdoor.com", "bbb.org", "yellowpages.com",
  "duckduckgo.com",
];

function isUsefulResultUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return !EXCLUDED_RESULT_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

async function discoverUrlsViaSearch(
  keyword: string,
  location: string | undefined,
  maxResults: number,
  logger: ReturnType<typeof createLogger>
): Promise<string[]> {
  const query = location ? `${keyword} ${location}` : keyword;
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  let page;
  try {
    page = await fetchPage(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    } as any);
  } catch (err: any) {
    await logger.log(`Keyword search fetch failed: ${err.message} — falling back to 0 candidate URLs`);
    return [];
  }

  if (!page.ok) {
    await logger.log(`Keyword search returned HTTP ${page.status} — falling back to 0 candidate URLs`);
    return [];
  }

  const linkRe = /<a\b[^>]*\bhref="([^"]+)"[^>]*>/g;
  const found: string[] = [];
  let m: RegExpExecArray | null;

  while ((m = linkRe.exec(page.html))) {
    let href = m[1].replace(/&amp;/g, "&");

    if (href.startsWith("/l/?") || href.includes("/l/?uddg=")) {
      const uddgMatch = href.match(/[?&]uddg=([^&]+)/);
      if (uddgMatch) href = decodeURIComponent(uddgMatch[1]);
      else continue;
    }

    if (!/^https?:\/\//i.test(href)) continue;
    if (href.includes("duckduckgo.com")) continue;
    found.push(href);
  }

  const deduped = [...new Set(found)].filter(isUsefulResultUrl);
  return deduped.slice(0, maxResults);
}

async function run(ctx: PluginContext): Promise<PluginResult> {
  const input = ctx.input as WebsiteJobInput;
  const logger = createLogger(ctx.jobId);

  // ── Plan gate ──────────────────────────────────────────────────────────
  const access = await checkSourceAccess(supabase, "website", ctx.userId, ctx.orgId);
  if (!access.allowed) {
    await logger.log(`Blocked: website not available on ${access.planName} plan.`);
    await logger.close();
    return {
      leads_found: 0, saved: 0, errors: 0, blocked: true,
      message: `Website scraping isn't available on your current plan.` +
        (access.requiredTier ? ` Upgrade to ${access.requiredTier}.` : ""),
    };
  }

  let urls: string[] = input.urls || [];
  if (urls.length === 0 && input.keyword) {
    await logger.log(`No urls provided — searching by keyword "${input.keyword}"`);
    urls = await discoverUrlsViaSearch(input.keyword, input.location, input.maxResults ?? 10, logger);
  }

  if (urls.length === 0) {
    await logger.log(`No URLs to scrape.`);
    await logger.close();
    return { leads_found: 0, saved: 0, errors: 0, emails: [] };
  }

  // ── Cache Check (Idempotent) ──────────────────────────────────────────────
  const activeEnrichments = Object.keys((input as any).enrichments || {}).filter(k => (input as any).enrichments[k]);
  const cacheKeyTarget = input.keyword ? `search:${input.keyword}` : `urls:${urls.join(",")}`;
  const cacheHit = await getCachedScrape(supabase, "website", cacheKeyTarget, "v1", logger);

  const scraped: any[] = [];
  let skippedNoBalance = 0;

  if (cacheHit.hit && cacheHit.data) {
    for (const item of cacheHit.data) scraped.push(item);
  } else {
    for (let i = 0; i < urls.length; i++) {
      const { data: scrapedData, provider } = await websiteRouter.fetch(
        { url: urls[i] },
        { jobId: ctx.jobId, logger, redis: ctx.redis }
      );
      const result = scrapedData[0] || null;
      if (result) await logger.log(`  served by provider "${provider}"`);
      if (result) {
        const validation = validateLead(result);
        if (validation.valid) scraped.push(result);
        else await logger.log(`  rejected: ${validation.reasons.join(", ")}`);
      }

      await ctx.updateProgress({ processedCount: i + 1, totalCount: urls.length });
    }
    
    if (scraped.length > 0) {
      await setCachedScrape(supabase, "website", cacheKeyTarget, scraped, "v1");
    }
  }

  await logger.close();

  const uploadResult = await saveLeads(supabase, scraped, ctx.userId, ctx.orgId, (item, userId, orgId) => {
    const row = baseRowMapper(item, userId, orgId, "website");
    row.social_links = item.social_links || {};
    row.tech_stack = item.tech_stack || [];
    return row;
  });

  // ── Deferred Charging ─────────────────────────────────────────────────────
  if (uploadResult.saved > 0) {
    const costPerLead = calculateLeadCost("website", {
      isCacheHit: cacheHit.hit,
      enrichments: activeEnrichments,
    });
    const totalCost = costPerLead * uploadResult.saved;
    const chargeResult = await chargeBatchForLeads(supabase, ctx.userId, ctx.orgId, totalCost);
    if (!chargeResult.charged) {
      console.error(`Failed to charge ${totalCost} credits: ${chargeResult.reason}`);
    }
  }

  return {
    leads_found: scraped.length,
    saved: uploadResult.saved,
    errors: uploadResult.errors,
    skippedNoBalance,
    emails: scraped.flatMap((s) => s.emails || []),
  };
}

export const websitePlugin: SourcePlugin = {
  name: "website",
  requiresBrowser: true, // Need browser available for Level 2 & 3
  run,
};
