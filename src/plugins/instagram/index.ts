/**
 * plugins/instagram/index.ts — Phase 2 SerpApi-First Architecture
 *
 * Flow: Search keyword via SerpApi (1 call = 50 results) -> Parse -> Validate -> Normalize -> Save
 * Fallback to Playwright ONLY on Timeout, Empty Response, or HTML Parse Failed.
 *
 * FIX (billing/correctness): same maxResults bug found in plugins/amazon,
 * plugins/ebay, and plugins/facebook — `input.maxResults` was never
 * declared or read. A single SerpApi call already returns up to 50
 * results; every one of them got saved AND charged for regardless of
 * what the user requested via the Discover page's "Max Results" control.
 */

import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import {
  getBrowserPool,
  SessionManager,
  getProxyManager,
  analyzeJobRisk,
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

import { instagramRouter } from "./router.js";
import { parseInstagramSerpResult } from "./parser.js";
import { validateInstagramProfile } from "./validator.js";
import { normalizeInstagramProfile } from "./normalizer.js";

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
const sessions = new SessionManager(supabase);

// FIX: same conservative default used across the other SerpApi plugins.
const DEFAULT_MAX_RESULTS = 10;

interface InstagramInput {
  keyword?: string;
  location?: string;
  profileUrls?: string[];
  enrichments?: Record<string, boolean>;
  maxResults?: number; // FIX: was missing from the type entirely
  // FIX: previously not declared or read — the Discover page's Instagram
  // filter panel (Business Only, Has Website, Has Public Email, Min
  // Followers, Industry) had zero effect on the actual scrape, on top of
  // the separate bug (fixed in /api/scrape) where these values never
  // even reached the worker at all.
  instagramFilters?: {
    searchType?: string;
    followers?: string;
    industry?: string;
    businessOnly?: boolean;
    hasWebsite?: boolean;
    hasPublicEmail?: boolean;
  };
}

function usernameFromUrl(url: string): string {
  return url.replace(/\/$/, "").split("/").pop() || "";
}

async function scrapeProfileFallback(page: import("playwright").Page, profileUrl: string): Promise<Record<string, any> | null> {
  await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });

  const loggedOut = await page.locator('text="Log in"').first().isVisible({ timeout: 2000 }).catch(() => false);
  if (loggedOut) throw new Error("SESSION_LOGGED_OUT");

  const notFound = await page.locator("text=Sorry, this page isn't available.").first().isVisible({ timeout: 2000 }).catch(() => false);
  if (notFound) return null;

  const header = await page.locator("header section").first();
  const bio = await header.locator("h1, div").allInnerTexts().catch(() => []);

  const statsText = await page.locator("header section ul").first().innerText().catch(() => "");
  const stats = statsText.split("\n").map((s) => s.trim());
  const parseCount = (s?: string) => {
    if (!s) return null;
    const num = s.replace(/[^\d.kmKM]/g, "");
    const mult = /k/i.test(num) ? 1_000 : /m/i.test(num) ? 1_000_000 : 1;
    const n = parseFloat(num.replace(/[km]/i, ""));
    return isNaN(n) ? null : Math.round(n * mult);
  };

  const externalLink = await header
    .locator('a[href^="http"]:not([href*="instagram.com"])')
    .first()
    .getAttribute("href")
    .catch(() => null);

  const rawProfile = {
    username: usernameFromUrl(profileUrl),
    name: usernameFromUrl(profileUrl),
    company: usernameFromUrl(profileUrl),
    bio: bio.join(" ").trim() || null,
    followersCount: parseCount(stats[1]),
    followsCount: parseCount(stats[2]),
    postsCount: parseCount(stats[0]),
    profileUrl,
    website: externalLink,
    instagram: profileUrl,
    source: "instagram",
  };

  const validated = validateInstagramProfile(rawProfile);
  if (!validated) return null;
  return normalizeInstagramProfile(validated);
}

async function runFallbackScrape(urls: string[], logger: ReturnType<typeof createLogger>, ctx: PluginContext) {
  const routing = analyzeJobRisk({ source: "instagram", type: "discover_scrape" });
  const proxy = await getProxyManager().getBest(routing);

  const pool = getBrowserPool();
  const lease = await pool.acquireContext({}); 
  const browser = (lease as any).context.browser();
  await lease.release();

  if (!browser) {
    await logger.log("Could not obtain a Browser handle from the pool for fallback");
    return [];
  }

  const sessionCtx = await sessions.acquireContextWithSession(
    "instagram",
    browser,
    proxy?.server ? { proxy: { server: proxy.server } } : {}
  );

  if (!sessionCtx) {
    await logger.log("No available Instagram session for fallback");
    return [];
  }

  const { context, lease: sessionLease } = sessionCtx;
  const results: Record<string, any>[] = [];
  let sessionBroken = false;

  try {
    const page = await context.newPage();
    for (let i = 0; i < urls.length; i++) {
      try {
        const profile = await scrapeProfileFallback(page, urls[i]);
        if (profile) results.push(profile);
      } catch (err: any) {
        if (err.message === "SESSION_LOGGED_OUT") {
          sessionBroken = true;
          await logger.log(`Session logged out mid-run at ${urls[i]} — stopping batch`);
          break;
        }
        await logger.log(`  fallback failed ${urls[i]}: ${err.message}`);
      }
      await sleep(1500 + Math.random() * 1500); 
    }
    if (proxy) await getProxyManager().markSuccess(proxy.id, Date.now());
  } catch (err: any) {
    if (proxy) await getProxyManager().markFail(proxy.id);
  } finally {
    const finalState = await context.storageState().catch(() => null);
    await context.close().catch(() => {});
    await sessionLease.release(
      sessionBroken ? { invalidate: true } : { updatedState: finalState || undefined }
    );
  }

  return results;
}

async function run(ctx: PluginContext): Promise<PluginResult> {
  const input = ctx.input as InstagramInput;
  const logger = createLogger(ctx.jobId);

  const access = await checkSourceAccess(supabase, "instagram", ctx.userId, ctx.orgId);
  if (!access.allowed) {
    await logger.log(`Blocked: instagram not available on ${access.planName} plan.`);
    await logger.close();
    return {
      leads_found: 0, saved: 0, errors: 0, blocked: true,
      message: `Instagram isn't available on your current plan.` +
        (access.requiredTier ? ` Upgrade to ${access.requiredTier}.` : ""),
    };
  }

  const activeEnrichments = Object.keys(input.enrichments || {}).filter(k => (input.enrichments as any)[k]);

  // FIX: same clamp pattern as the other SerpApi plugins.
  const maxResults =
    Number.isFinite(input.maxResults) && (input.maxResults as number) > 0
      ? Math.floor(input.maxResults as number)
      : DEFAULT_MAX_RESULTS;

  // ── Cache Check ──────────────────────────────────────────────
  const cacheKeyTarget = input.keyword ? `search:${input.keyword}:${input.location || ""}` : (input.profileUrls || []).join(",");
  const cacheHit = await getCachedScrape(supabase, "instagram", cacheKeyTarget, "v1", logger);

  let results: Record<string, any>[] = [];
  let skippedNoBalance = 0;

  if (cacheHit.hit && cacheHit.data) {
    results = cacheHit.data;
  } else {
    // ── API-First Discovery ──────────────────────────────────────────────
    if (input.keyword) {
      try {
        await logger.log(`Searching SerpApi for "${input.keyword}"...`);
        const { data: serpData, provider } = await instagramRouter.fetch(
          { keyword: input.keyword, location: input.location, filters: input.instagramFilters },
          { jobId: ctx.jobId, logger, redis: ctx.redis }
        );
        await logger.log(`Instagram keyword search served by provider "${provider}".`);
        
        for (const item of serpData) {
          const parsed = parseInstagramSerpResult(item);
          if (parsed) {
            const validated = validateInstagramProfile(parsed);
            if (validated) {
              const normalized = normalizeInstagramProfile(validated);
              results.push(normalized);
            }
          }
        }
      } catch (err: any) {
        if (err instanceof ProviderError) {
          await logger.log(`SerpApi Error: ${err.type} - ${err.message}`);
          
          if ([ProviderErrorType.TIMEOUT, ProviderErrorType.EMPTY_RESULT, ProviderErrorType.HTML_PARSE].includes(err.type)) {
             await logger.log(`Triggering browser fallback due to ${err.type}`);
             // If we had input.profileUrls we could fallback, but for a keyword search fallback requires Google Search scraping via browser
             // which is complex. If there are explicit profileUrls, we fallback.
          }
        } else {
          await logger.log(`Unexpected error: ${err.message}`);
        }
      }
    }

    if (input.profileUrls && input.profileUrls.length > 0 && results.length === 0) {
       // Direct URLs passed or API failed for specific profiles (fallback logic)
       // Here we assume if they passed specific profileUrls, we try them via fallback if needed
       // (Or maybe we'd pass them to a SerpApi profile endpoint in the future)
       await logger.log(`Processing ${input.profileUrls.length} URLs via Browser Fallback...`);
       results = await runFallbackScrape(input.profileUrls, logger, ctx);
    }

    if (results.length > 0) {
      await setCachedScrape(supabase, "instagram", cacheKeyTarget, results, "v1");
    }
  }

  // FIX: followers/hasWebsite/hasPublicEmail can't be sent as query params
  // to a Google site:search — applying as a post-filter instead.
  //
  // CONFIRMED against parser.ts/normalizer.ts: item.followersCount is a
  // top-level field (set by parseInstagramSerpResult from the Google
  // snippet's "10K Followers, ..." text). item.website and item.email are
  // both set by normalizeInstagramProfile from regex matches against the
  // bio text — so they'll often be null in practice (most bios don't
  // contain a literal https:// link or a bare email), not because the
  // filter is broken, but because Google's indexed Instagram snippets
  // rarely expose that data. Real hit-rate will likely be low; that's a
  // data-availability limit, not a bug.
  const igf = input.instagramFilters;
  if (igf && (igf.followers || igf.hasWebsite || igf.hasPublicEmail)) {
    const before = results.length;
    results = results.filter((item: any) => {
      if (igf.followers && Number(item.followersCount ?? 0) < Number(igf.followers)) return false;
      if (igf.hasWebsite && !item.website) return false;
      if (igf.hasPublicEmail && !item.email) return false;
      return true;
    });
    await logger.log(`Followers/website/email filters applied: ${before} → ${results.length} results (verify field names in normalizeInstagramProfile if this seems to have no effect).`);
  }

  // FIX: enforce maxResults after filtering — the cap applies to the
  // filtered set the user's criteria actually matched, and this is the
  // point where the SerpApi-search path, the profileUrls-fallback path,
  // and the cache-hit path have all converged, so none of them can
  // bypass it.
  if (results.length > maxResults) {
    await logger.log(`Truncating ${results.length} results to requested maxResults=${maxResults}.`);
    results = results.slice(0, maxResults);
  }

  const uploadResult = await saveLeads(supabase, results, ctx.userId, ctx.orgId, (item, userId, orgId) =>
    baseRowMapper(item, userId, orgId, "instagram")
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
    // Only pass isCacheHit, do NOT pass enrichments array (step-by-step charging)
    const costPerLead = calculateLeadCost("instagram", {
      isCacheHit: cacheHit.hit,
      enrichments: [], // Excluded so we don't charge for website/ai right now
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

export const instagramPlugin: SourcePlugin = {
  name: "instagram",
  requiresBrowser: true,
  run,
};
