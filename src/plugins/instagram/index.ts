/**
 * plugins/instagram/index.ts
 * Instagram Business Profile Scraper — 3-Provider Fallback Chain
 *
 * Provider order (Instagram):
 *   1. Apify (primary)          — apify/instagram-scraper actor, richest data
 *   2. SerpApi (fallback)       — Google search → username list → limited data
 *   3. Profile-Enricher (fallback) — own browser scraper for deep enrichment
 *
 * All browser work (Layer 3 only) runs through SessionManager
 * (optimistic locking, stealth fingerprint, residential proxy).
 */

import {
  getBrowserPool,
  SessionManager,
  saveLeads,
  baseRowMapper,
  calculateLeadCost,
  chargeBatchForLeads,
} from "@compx/scraper-core";
import type { PluginContext, PluginResult, SourcePlugin } from "@compx/scraper-core";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

import { discoverInstagramProfilesViaApify } from "./providers/apify.js";
import { discoverUsernamesViaSerpApi } from "./providers/serpapi.js";
import { enrichProfiles, type EnrichedProfile } from "./providers/profile-enricher.js";

// ─── Supabase singleton ───────────────────────────────────────────────────────
let _supabase: any = null;
function getSupabase() {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
    _supabase = createClient(url, key, { realtime: { transport: ws as any } });
  }
  return _supabase;
}

// ─── Types ────────────────────────────────────────────────────────────────────
export interface InstagramScraperInput {
  keyword?: string;
  keywords?: string;
  data?: { keyword?: string };
  location?: string;
  maxResults?: number;
  instagramFilters?: {
    businessOnly?: boolean;
    hasWebsite?: boolean;
    hasPublicEmail?: boolean;
    minFollowers?: number;
    industry?: string;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** Convert EnrichedProfile → normalized lead record for our DB schema. */
function toLeadRecord(profile: EnrichedProfile, filters: InstagramScraperInput["instagramFilters"] = {}) {
  return {
    source: "instagram",
    username: `@${profile.username}`,
    business_name: profile.name || profile.username,
    bio: profile.bio || null,
    email: profile.email || null,
    phone: profile.phone || null,
    website: profile.website || null,
    profile_url: profile.profileUrl,
    followers_count: profile.followersCount,
    following_count: profile.followingCount,
    posts_count: profile.postsCount,
    is_verified: profile.isVerified,
    is_business: profile.isBusiness,
    category: profile.category || filters?.industry || null,
    industry: filters?.industry || null,
  };
}

/** Apply post-enrichment filters to the collected profiles. */
function applyFilters(profiles: EnrichedProfile[], filters: InstagramScraperInput["instagramFilters"] = {}) {
  return profiles.filter((p) => {
    if (filters.businessOnly && !p.isBusiness) return false;
    if (filters.hasWebsite && !p.website) return false;
    if (filters.hasPublicEmail && !p.email) return false;
    if (filters.minFollowers && (p.followersCount ?? 0) < filters.minFollowers) return false;
    return true;
  });
}

// ─── Main scraper function ────────────────────────────────────────────────────
async function scrapeInstagramProfiles(input: any): Promise<any[]> {
  // Normalise nested input shapes sent by the job system
  const actualInput: InstagramScraperInput = input.input || input.data || input;
  const keyword = (actualInput.keyword || actualInput.keywords || "").trim();
  const location = actualInput.location;
  const maxResults = actualInput.maxResults || 50;
  const filters = actualInput.instagramFilters || {};
  const proxy = input.proxy ?? null;

  const logger = {
    log: async (msg: string) => console.log(msg),
    warn: async (msg: string) => console.warn(msg),
  };

  console.log("📥 Extracted keyword:", keyword);
  if (!keyword) {
    await logger.log(`❌ No keyword provided. Received: ${JSON.stringify(actualInput, null, 2)}`);
    throw new Error("KEYWORD_REQUIRED");
  }

  await logger.log(`🔍 Starting Instagram search: "${keyword}" ${location ? `in ${location}` : ""}`);

  // ══════════════════════════════════════════════════════════════════════════
  // PROVIDER 1: Apify (PRIMARY)
  // ══════════════════════════════════════════════════════════════════════════
  if (process.env.APIFY_API_TOKEN) {
    try {
      await logger.log("🚀 [Provider 1] Apify — primary discovery + enrichment...");
      const profiles = await discoverInstagramProfilesViaApify({
        keyword,
        location,
        maxResults,
        filters: {
          businessOnly: filters.businessOnly,
          hasWebsite: filters.hasWebsite,
          hasPublicEmail: filters.hasPublicEmail,
          minFollowers: filters.minFollowers,
          industry: filters.industry,
        },
      });
      await logger.log(`✅ [Provider 1] Apify returned ${profiles.length} profiles`);
      return profiles.map((p) => toLeadRecord(p, filters));
    } catch (e: any) {
      await logger.log(`⚠️ [Provider 1] Apify failed: ${e.message} — falling back to SerpApi`);
    }
  } else {
    await logger.log("⚠️ [Provider 1] APIFY_API_TOKEN not set — skipping Apify");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PROVIDER 2: SerpApi (FALLBACK)
  // ══════════════════════════════════════════════════════════════════════════
  const serpUsernames = new Map<string, string>(); // username → name
  let serpSucceeded = false;

  if (process.env.SERPAPI_API_KEY) {
    try {
      await logger.log("🌐 [Provider 2] SerpApi — discovery fallback...");
      const stubs = await discoverUsernamesViaSerpApi({
        keyword,
        location,
        maxResults,
        filters: {
          industry: filters.industry,
          businessOnly: filters.businessOnly,
        },
      });
      for (const s of stubs) serpUsernames.set(s.username, s.name);
      serpSucceeded = true;
      await logger.log(`✅ [Provider 2] SerpApi found ${serpUsernames.size} usernames`);
    } catch (e: any) {
      await logger.log(`⚠️ [Provider 2] SerpApi failed: ${e.message} — falling back to browser scraper`);
    }
  } else {
    await logger.log("⚠️ [Provider 2] SERPAPI_API_KEY not set — skipping SerpApi");
  }

  // If SerpApi succeeded we have usernames to enrich with the own scraper
  // If SerpApi also failed, profile-enricher can't do much without usernames —
  // we'll try the hashtag discovery path inside enricher as a last resort.

  // ══════════════════════════════════════════════════════════════════════════
  // PROVIDER 3: Own browser profile-enricher (FALLBACK)
  // ══════════════════════════════════════════════════════════════════════════
  await logger.log("🔬 [Provider 3] Browser profile-enricher — own scraper fallback...");

  const supabase = getSupabase();
  const sessionManager = new SessionManager(supabase);
  const pool = getBrowserPool();
  const poolLease = await pool.acquireContext({});
  const browser = (poolLease as any).context.browser();

  const sessionResult = await sessionManager.acquireContextWithSession("instagram", browser, {
    proxy,
    platform: "instagram",
  });

  if (!sessionResult) {
    await poolLease.release();
    const errMsg = serpSucceeded
      ? "Instagram session required for enrichment. Run login.ts first!"
      : "All providers failed: no Apify token, SerpApi failed, and no Instagram session.";
    await logger.log(`❌ ${errMsg}`);
    throw new Error("INSTAGRAM_SESSION_REQUIRED");
  }

  const { context, lease: sessionLease } = sessionResult;
  await logger.log("✅ [Provider 3] Instagram session acquired");

  const allUsernames = new Set<string>(serpUsernames.keys());
  let sessionBlocked = false;

  try {
    // If SerpApi gave us nothing, try hashtag discovery in browser
    if (allUsernames.size === 0) {
      await logger.log("🏷️ [Provider 3] No usernames from SerpApi — trying hashtag discovery...");
      try {
        const { discoverUsernamesViaHashtags } = await import("./providers/hashtag.js");
        const hashtagStubs = await discoverUsernamesViaHashtags(
          context,
          { keyword, location, maxResults },
          new Set<string>()
        );
        for (const s of hashtagStubs) allUsernames.add(s.username);
        await logger.log(`✅ [Provider 3] Hashtag discovery added ${hashtagStubs.length} usernames`);
      } catch (e: any) {
        await logger.log(`⚠️ [Provider 3] Hashtag discovery failed: ${e.message}`);
      }
    }

    if (allUsernames.size === 0) {
      await logger.log("❌ All providers exhausted — no usernames to enrich.");
      return [];
    }

    await logger.log(`📋 [Provider 3] Enriching ${allUsernames.size} profiles...`);

    const enriched = await enrichProfiles(
      context,
      [...allUsernames],
      {
        maxProfiles: maxResults,
        onProgress: async (done, total, profile) => {
          await logger.log(
            `📊 ${done}/${total} — @${profile.username} ` +
            `(${profile.followersCount?.toLocaleString() ?? "?"} followers` +
            `${profile.email ? ", ✉️" : ""}` +
            `${profile.phone ? ", 📞" : ""}` +
            `${profile.website ? ", 🌐" : ""})`
          );
        },
        onBlocked: () => { sessionBlocked = true; },
      }
    );

    const filtered = applyFilters(enriched, filters);
    await logger.log(
      `✅ [Provider 3] Done: ${enriched.length} scraped, ${filtered.length} passed filters`
    );
    return filtered.map((p) => toLeadRecord(p, filters));

  } finally {
    try {
      const finalState = await context.storageState();
      await sessionLease.release({ updatedState: finalState });
      if (sessionBlocked) console.warn("[Instagram] Session was blocked — marking as invalidated");
    } catch {
      await sessionLease.release({ invalidate: sessionBlocked });
    }
    await context.close().catch(() => {});
    await poolLease.release().catch(() => {});
  }
}

async function run(ctx: PluginContext): Promise<PluginResult> {
  const input = ctx.input;
  const actualInput: InstagramScraperInput = input.input || input.data || input;
  const activeEnrichments = Object.keys(actualInput.instagramFilters || {}).filter(
    (k) => (actualInput.instagramFilters as any)[k] === true
  );

  const supabase = getSupabase();

  // Run the scraper
  const results = await scrapeInstagramProfiles(ctx);

  // Save Leads
  const uploadResult = await saveLeads(
    supabase,
    results,
    ctx.userId,
    ctx.orgId,
    (item, userId, orgId) => baseRowMapper(item, userId, orgId, "instagram")
  );

  // Enrichment Dispatch
  for (const item of results) {
    if (item.website && activeEnrichments.includes("website") && ctx.dispatchEnrichment) {
      await ctx.dispatchEnrichment("website", { domain: item.website });
    }
  }

  // Charge on Success
  if (uploadResult.saved > 0) {
    const costPerLead = calculateLeadCost("instagram", { isCacheHit: false, enrichments: [] });
    const totalCost = costPerLead * uploadResult.saved;
    const chargeResult = await chargeBatchForLeads(supabase, ctx.userId, ctx.orgId, totalCost);
    if (!chargeResult.charged) {
      console.error(`[Instagram] Failed to charge ${totalCost} credits: ${chargeResult.reason}`);
    }
  }

  return {
    leads_found: results.length,
    saved: uploadResult.saved,
    errors: uploadResult.errors,
  };
}

// ─── Plugin export (matches worker-registry contract) ────────────────────────
export const instagramPlugin: SourcePlugin = {
  name: "instagram-profile-scraper",
  requiresBrowser: true,
  run,
};

export const instagramProfileScraperProvider = instagramPlugin;
