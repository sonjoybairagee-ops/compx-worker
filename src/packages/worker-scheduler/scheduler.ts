/**
 * workers/scheduler/scheduler.ts
 *
 * Phase 16: "Scheduler → Popular Searches → Pre Scrape → Database Ready".
 * Fully adapted for Supabase-only architecture (No Redis, No BullMQ).
 * Uses pgBoss for job scheduling and Supabase cache table for TTL checks.
 */

import { SupabaseClient } from "@supabase/supabase-js";
import type PgBoss from "pg-boss";
import { buildCacheKey } from "@compx/scraper-core";

const SCHEDULE_INTERVAL_MS = 60 * 60_000; // hourly
const LOOKBACK_DAYS = 7;
const TOP_N_SEARCHES = 20;
// Refresh if cache was updated more than 4 hours ago (equivalent to <4h TTL remaining)
const CACHE_AGE_THRESHOLD_MS = 4 * 60 * 60 * 1000; 

interface PopularSearch {
  source: string;
  keyword: string;
  location: string | null;
  search_count: number;
}

async function getPopularSearches(supabase: SupabaseClient): Promise<PopularSearch[]> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60_000).toISOString();

  const { data, error } = await supabase.rpc("get_popular_searches", {
    p_since: since,
    p_limit: TOP_N_SEARCHES,
  });

  if (error) {
    console.error("[Scheduler] get_popular_searches RPC failed:", error.message);
    return [];
  }
  return data || [];
}

/**
 * Checks if a cached entry needs refresh using Supabase scrape_cache table.
 * Replaces redis.ttl() check with timestamp-based age calculation.
 */
async function needsCacheRefresh(
  supabase: SupabaseClient, 
  source: string, 
  params: Record<string, any>
): Promise<boolean> {
  try {
    const target = buildCacheKey(source, params);
    
    const { data, error } = await supabase
      .from("scrape_cache")
      .select("updated_at")
      .eq("source", source)
      .eq("target", target)
      .single();

    // If no cache exists or query failed, it's cold → needs refresh
    if (error || !data) return true;

    const lastUpdated = new Date(data.updated_at).getTime();
    const ageMs = Date.now() - lastUpdated;
    
    // Needs refresh if older than threshold
    return ageMs > CACHE_AGE_THRESHOLD_MS;
  } catch (err) {
    console.warn("[Scheduler] Cache check failed, assuming cold:", err);
    return true; // Fail-safe: assume needs refresh on error
  }
}

export function startScheduler(
  supabase: SupabaseClient, 
  boss: PgBoss, // ✅ Replaced BullMQ Queue with PgBoss instance
  systemUserId: string // ✅ Required: pgBoss jobs need a valid user_id
) {
  const tick = async () => {
    try {
      const popular = await getPopularSearches(supabase);
      if (!popular.length) return;

      console.log(`[Scheduler] Checking ${popular.length} popular search(es) for pre-scrape`);

      for (const search of popular) {
        const params = { keyword: search.keyword, location: search.location };
        
        // ✅ FIX: Check cache age via Supabase instead of Redis TTL
        const shouldRefresh = await needsCacheRefresh(supabase, search.source, params);
        if (!shouldRefresh) continue;

        console.log(`[Scheduler] Pre-scraping "${search.keyword}" (${search.source}) — cache is stale/cold`);

        // ✅ FIX: Use correct pg-boss queue name "compx-jobs" (not "discover_scrape")
        await boss.send("compx-jobs", {
          type: "discover_scrape",
          user_id: systemUserId,
          billing_user_id: systemUserId,
          input_data: {
            source: search.source,
            keyword: search.keyword,
            location: search.location,
            _prescrape: true, // Dispatcher skips credit deduction for these
          },
        }, {
          priority: 10, // Lower priority than real user jobs
          retryLimit: 1, // Pre-scrapes shouldn't retry endlessly
        });
      }
    } catch (err: any) {
      console.error("[Scheduler] tick error:", err.message);
    }
  };

  console.log(`[Scheduler] Started — checking popular searches every ${SCHEDULE_INTERVAL_MS / 60_000}min`);
  const interval = setInterval(tick, SCHEDULE_INTERVAL_MS);
  
  // Run once on boot
  tick().catch(err => console.error("[Scheduler] Initial tick failed:", err));

  return () => clearInterval(interval);
}