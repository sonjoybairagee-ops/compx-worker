/**
 * plugins/linkedin/index.ts — 3-Provider Fallback Chain
 *
 * Provider order (LinkedIn):
 *   1. Apify (primary)          — apify/linkedin-profile-scraper actor, richest data
 *   2. SerpApi (fallback)       — Google search → profile URL list
 *   3. Own profile-scraper (fallback) — browser session + residential proxy
 *
 * LinkedIn is the strictest platform — rate limits are aggressive.
 * Session must be a real logged-in LinkedIn account with residential proxy.
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

import { discoverLinkedinProfilesViaApify } from "./providers/apify.js";
import { discoverLinkedinProfilesViaSerpApi } from "./providers/serpapi.js";
import { searchLinkedInProfiles } from "./providers/search-scraper.js";
import { enrichLinkedinProfiles, type LinkedinEnrichedProfile } from "./providers/profile-scraper.js";

// ─── Supabase ─────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
  { realtime: { transport: ws as any } }
);

const DEFAULT_MAX_RESULTS = 10;

interface LinkedinFilters {
  targetAudiences?: string[];
  companyTypes?: string[];
  jobTitles?: string[];
  employeeSizes?: string[];
  companyLegalTypes?: string[];
}

interface LinkedinInput {
  keyword?: string;
  location?: string;
  searchType?: "people" | "company" | "both";
  linkedinFilters?: LinkedinFilters;
  enrichments?: Record<string, boolean>;
  maxResults?: number;
  // Legacy: direct profile URLs (for backwards compatibility)
  profileUrls?: string[];
}

// ─── Build lead record from enriched profile ──────────────────────────────────
function buildLeadRecord(profile: LinkedinEnrichedProfile): Record<string, any> {
  return {
    source: "linkedin",
    name: profile.name,
    company: profile.company,
    contact_title: profile.headline,
    address: profile.location,
    about: profile.about,
    email: profile.email,
    phone: profile.phone,
    website: profile.website,
    linkedin: profile.profileUrl,
    extra_data: {
      type: profile.type,
      connection_count: profile.connectionCount,
      follower_count: profile.followerCount,
      profile_url: profile.profileUrl,
    },
  };
}

// ─── Main plugin run ──────────────────────────────────────────────────────────
async function run(ctx: PluginContext): Promise<PluginResult> {
  const input = ctx.input as LinkedinInput;
  const logger = createLogger(ctx.jobId);

  // ── Plan Gate ─────────────────────────────────────────────────
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

  const maxResults = Number.isFinite(input.maxResults) && (input.maxResults as number) > 0
    ? Math.floor(input.maxResults as number)
    : DEFAULT_MAX_RESULTS;

  const activeEnrichments = Object.keys(input.enrichments || {}).filter(k => (input.enrichments as any)[k]);
  const proxy = (ctx as any).proxy ?? null;

  // ── Legacy mode: direct profileUrls provided ──────────────────
  if (input.profileUrls && input.profileUrls.length > 0 && !input.keyword) {
    await logger.log(`Legacy mode: enriching ${input.profileUrls.length} direct URLs...`);
    const stubs = input.profileUrls.map(url => ({
      profileUrl: url,
      type: "person" as const,
      name: url,
    }));

    let results: Record<string, any>[] = [];
    try {
      const enriched = await enrichLinkedinProfiles({ stubs, options: { proxy, maxProfiles: maxResults } });
      results = enriched.map(buildLeadRecord);
    } catch (err: any) {
      await logger.log(`❌ Enrichment error: ${err.message}`);
      await logger.close();
      return { leads_found: 0, saved: 0, errors: 1 };
    }

    const uploadResult = await saveLeads(supabase, results, ctx.userId, ctx.orgId,
      (item, userId, orgId) => baseRowMapper(item, userId, orgId, "linkedin")
    );

    if (uploadResult.saved > 0) {
      const cost = calculateLeadCost("linkedin", { isCacheHit: false, enrichments: [] });
      await chargeBatchForLeads(supabase, ctx.userId, ctx.orgId, cost * uploadResult.saved);
    }

    await logger.close();
    return { leads_found: results.length, saved: uploadResult.saved, errors: uploadResult.errors };
  }

  // ── Keyword mode ──────────────────────────────────────────────
  if (!input.keyword) {
    await logger.log("No keyword or profileUrls provided — aborting.");
    await logger.close();
    return { leads_found: 0, saved: 0, errors: 1 };
  }

  // ── Cache Check ───────────────────────────────────────────────
  const cacheKey = `li:${input.keyword}:${input.location || ""}:${input.searchType || "people"}`;
  const cacheHit = await getCachedScrape(supabase, "linkedin", cacheKey, "v2", logger);

  let results: Record<string, any>[] = [];

  if (cacheHit.hit && cacheHit.data) {
    await logger.log(`Cache hit for "${input.keyword}" — skipping discovery.`);
    results = cacheHit.data;
  } else {

    // ══════════════════════════════════════════════════════════════════════════
    // PROVIDER 1: Apify (PRIMARY)
    // ══════════════════════════════════════════════════════════════════════════
    if (process.env.APIFY_API_TOKEN) {
      try {
        await logger.log(`🚀 [Provider 1] Apify — primary discovery for "${input.keyword}" ${input.location || ""}...`);
        const profiles = await discoverLinkedinProfilesViaApify({
          keyword: input.keyword,
          location: input.location,
          searchType: input.searchType || "people",
          maxResults,
          jobTitles: input.linkedinFilters?.jobTitles || [],
          targetAudiences: input.linkedinFilters?.targetAudiences || [],
        });
        await logger.log(`✅ [Provider 1] Apify returned ${profiles.length} profiles`);
        results = profiles.map(buildLeadRecord);
      } catch (err: any) {
        await logger.log(`⚠️ [Provider 1] Apify failed: ${err.message} — falling back to SerpApi`);
      }
    } else {
      await logger.log("⚠️ [Provider 1] APIFY_API_TOKEN not set — skipping Apify");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PROVIDER 2: SerpApi (FALLBACK)
    // ══════════════════════════════════════════════════════════════════════════
    if (results.length === 0) {
      if (process.env.SERPAPI_API_KEY) {
        try {
          await logger.log(`🌐 [Provider 2] SerpApi — discovery fallback for "${input.keyword}"...`);
          const stubs = await discoverLinkedinProfilesViaSerpApi({
            keyword: input.keyword,
            location: input.location,
            maxResults,
            searchType: input.searchType || "people",
          });
          await logger.log(`✅ [Provider 2] SerpApi found ${stubs.length} profile URLs — enriching with own scraper...`);

          // Enrich the SerpApi stubs with browser session
          const enrichStubs = stubs.map(s => ({ profileUrl: s.profileUrl, type: s.type, name: s.name }));
          try {
            const enriched = await enrichLinkedinProfiles({
              stubs: enrichStubs,
              options: {
                proxy,
                maxProfiles: maxResults,
                onProgress: async (done, total, profile) => {
                  await logger.log(
                    `📊 [Provider 2] ${done}/${total}: ${profile.name || "unknown"} ` +
                    `${profile.headline ? "— " + profile.headline.substring(0, 50) : ""} ` +
                    `${profile.email ? "| ✉️" : ""}${profile.phone ? " | 📞" : ""}${profile.website ? " | 🌐" : ""}`
                  );
                },
                onBlocked: async () => {
                  await logger.log("🚨 LinkedIn session blocked during SerpApi enrichment!");
                },
              },
            });
            results = enriched.map(buildLeadRecord);
            await logger.log(`✅ [Provider 2] SerpApi + enricher: ${results.length} profiles enriched`);
          } catch (enrichErr: any) {
            // If enrichment fails (e.g. no session), use raw stubs with partial data
            await logger.log(`⚠️ [Provider 2] Enrichment failed: ${enrichErr.message} — using SerpApi stubs only`);
            results = stubs.map(s => ({
              source: "linkedin",
              name: s.name,
              contact_title: s.headline,
              about: s.snippet,
              linkedin: s.profileUrl,
              extra_data: { type: s.type, profile_url: s.profileUrl },
            }));
          }
        } catch (err: any) {
          await logger.log(`⚠️ [Provider 2] SerpApi failed: ${err.message} — falling back to own browser search`);
        }
      } else {
        await logger.log("⚠️ [Provider 2] SERPAPI_API_KEY not set — skipping SerpApi");
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PROVIDER 3: Own browser search-scraper + profile-scraper (FALLBACK)
    // ══════════════════════════════════════════════════════════════════════════
    if (results.length === 0) {
      await logger.log(`🔬 [Provider 3] Own browser scraper — last resort for "${input.keyword}"...`);
      let stubs: Array<{ profileUrl: string; type: "person" | "company"; name: string }> = [];

      try {
        const { SessionManager, getBrowserPool } = await import("@compx/scraper-core");
        const { createClient: mkClient } = await import("@supabase/supabase-js");
        const { default: wsLib } = await import("ws");

        const searchSupabase = mkClient(
          process.env.SUPABASE_URL || "",
          process.env.SUPABASE_SERVICE_ROLE_KEY || "",
          { realtime: { transport: wsLib as any } }
        );
        const sessionManager = new SessionManager(searchSupabase);
        const pool = getBrowserPool();
        const poolLease = await pool.acquireContext({});
        const browser = (poolLease as any).context.browser();

        const sessionResult = await sessionManager.acquireContextWithSession("linkedin", browser, {
          proxy,
          platform: "linkedin",
        });

        if (!sessionResult) {
          await poolLease.release();
          await logger.log("❌ [Provider 3] No LinkedIn session found. All providers exhausted.");
          await logger.close();
          return { leads_found: 0, saved: 0, errors: 1 };
        }

        const { context: searchContext, lease: searchLease } = sessionResult;

        try {
          const raw = await searchLinkedInProfiles(searchContext, {
            keyword: input.keyword!,
            location: input.location,
            searchType: input.searchType || "people",
            jobTitles: input.linkedinFilters?.jobTitles || [],
            targetAudiences: input.linkedinFilters?.targetAudiences || [],
            maxResults,
          });
          stubs = raw.map(s => ({ profileUrl: s.profileUrl, type: s.type, name: s.name }));
        } finally {
          const finalState = await searchContext.storageState().catch(() => null);
          await searchLease.release({ updatedState: finalState ?? undefined });
          await searchContext.close().catch(() => {});
          await poolLease.release().catch(() => {});
        }

        await logger.log(`✅ [Provider 3] Browser search found ${stubs.length} profiles — enriching...`);

        if (stubs.length === 0) {
          await logger.log("No profiles found via browser search. Aborting.");
          await logger.close();
          return { leads_found: 0, saved: 0, errors: 0 };
        }

        const enriched = await enrichLinkedinProfiles({
          stubs,
          options: {
            proxy,
            maxProfiles: maxResults,
            onProgress: async (done, total, profile) => {
              await logger.log(
                `📊 [Provider 3] ${done}/${total}: ${profile.name || "unknown"} ` +
                `${profile.headline ? "— " + profile.headline.substring(0, 50) : ""} ` +
                `${profile.email ? "| ✉️" : ""}${profile.phone ? " | 📞" : ""}${profile.website ? " | 🌐" : ""}`
              );
            },
            onBlocked: async () => {
              await logger.log("🚨 [Provider 3] LinkedIn session blocked!");
            },
          },
        });

        results = enriched.map(buildLeadRecord);
        await logger.log(`✅ [Provider 3] Own scraper done: ${results.length} profiles enriched`);

      } catch (err: any) {
        await logger.log(`❌ [Provider 3] Own scraper failed: ${err.message}`);
        await logger.close();
        return { leads_found: 0, saved: 0, errors: 1 };
      }
    }

    if (results.length > 0) {
      await setCachedScrape(supabase, "linkedin", cacheKey, results, "v2");
    }
  }

  // Enforce maxResults
  if (results.length > maxResults) results = results.slice(0, maxResults);

  // ── Save Leads ─────────────────────────────────────────────
  const uploadResult = await saveLeads(supabase, results, ctx.userId, ctx.orgId,
    (item, userId, orgId) => baseRowMapper(item, userId, orgId, "linkedin")
  );

  // ── Enrichment Dispatch ────────────────────────────────────
  for (const item of results) {
    if (item.website && activeEnrichments.includes("website") && ctx.dispatchEnrichment) {
      await ctx.dispatchEnrichment("website", { domain: item.website });
    }
  }
  if (activeEnrichments.includes("ai") && ctx.dispatchEnrichment) {
    for (const leadId of uploadResult.savedIds) {
      await ctx.dispatchEnrichment("ai", { leadId });
    }
  }

  // ── Charge on Success ──────────────────────────────────────
  if (uploadResult.saved > 0) {
    const cost = calculateLeadCost("linkedin", { isCacheHit: cacheHit.hit, enrichments: [] });
    const chargeResult = await chargeBatchForLeads(supabase, ctx.userId, ctx.orgId, cost * uploadResult.saved);
    if (!chargeResult.charged) {
      console.error(`[LinkedIn] Failed to charge credits: ${chargeResult.reason}`);
    }
  }

  await logger.close();

  return {
    leads_found: results.length,
    saved: uploadResult.saved,
    errors: uploadResult.errors,
  };
}

export const linkedinPlugin: SourcePlugin = {
  name: "linkedin",
  requiresBrowser: true,
  run,
};