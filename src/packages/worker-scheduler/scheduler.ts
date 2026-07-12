/**
 * workers/scheduler/scheduler.ts
 *
 * Phase 16: "Scheduler → Popular Searches → Pre Scrape → Database Ready".
 * Did not exist in the old codebase. Runs on an interval inside the worker
 * process (no separate infra needed): looks at which (source, keyword,
 * location) combos got searched most in the last N days, and if the
 * Redis cache (storage/cache.ts) for that combo is cold or near-expiry,
 * queues a background discover_scrape job to refresh it — so the *next*
 * real user gets an instant cache hit instead of waiting on a live scrape.
 *
 * Reads from a `search_log` table that dispatchJob() should insert into on
 * every discover_scrape (one-line addition, see the hook note at the
 * bottom).
 */

import { SupabaseClient } from "@supabase/supabase-js";
import type { Queue } from "bullmq";
import { buildCacheKey } from "@compx/scraper-core";
import type { Redis } from "ioredis";

const SCHEDULE_INTERVAL_MS = 60 * 60_000; // hourly
const LOOKBACK_DAYS = 7;
const TOP_N_SEARCHES = 20;
const REFRESH_THRESHOLD_TTL_SECONDS = 4 * 60 * 60; // refresh if cache has <4h left

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

export function startScheduler(supabase: SupabaseClient, redis: Redis, discoverQueue: Queue) {
  const tick = async () => {
    try {
      const popular = await getPopularSearches(supabase);
      if (!popular.length) return;

      console.log(`[Scheduler] Checking ${popular.length} popular search(es) for pre-scrape`);

      for (const search of popular) {
        const params = { keyword: search.keyword, location: search.location };
        const key = buildCacheKey(search.source, params);
        const ttl = await redis.ttl(key);

        // ttl === -2 → key doesn't exist at all; -1 → exists with no expiry (shouldn't happen, we always set EX)
        const needsRefresh = ttl === -2 || (ttl > 0 && ttl < REFRESH_THRESHOLD_TTL_SECONDS);
        if (!needsRefresh) continue;

        console.log(`[Scheduler] Pre-scraping "${search.keyword}" (${search.source}) — cache ${ttl === -2 ? "cold" : `expiring in ${ttl}s`}`);

        await discoverQueue.add(
          "discover_scrape",
          {
            type: "discover_scrape",
            user_id: "system_scheduler",
            input_data: {
              source: search.source,
              keyword: search.keyword,
              location: search.location,
              _prescrape: true, // marks this as background, not user-triggered — dispatcher can skip credit deduction for these
            },
          },
          { priority: 10 } // lower priority than real user jobs (BullMQ: lower number = higher priority)
        );
      }
    } catch (err: any) {
      console.error("[Scheduler] tick error:", err.message);
    }
  };

  console.log(`[Scheduler] Started — checking popular searches every ${SCHEDULE_INTERVAL_MS / 60_000}min`);
  const interval = setInterval(tick, SCHEDULE_INTERVAL_MS);
  tick(); // run once on boot

  return () => clearInterval(interval);
}

/**
 * DB HOOK — this SQL function needs to exist (adjust table/column names to
 * match your actual search-log schema):
 *
 *   create or replace function get_popular_searches(p_since timestamptz, p_limit int)
 *   returns table(source text, keyword text, location text, search_count bigint)
 *   language sql stable as $$
 *     select source, keyword, location, count(*) as search_count
 *     from search_log
 *     where created_at >= p_since
 *     group by source, keyword, location
 *     order by search_count desc
 *     limit p_limit;
 *   $$;
 *
 * DISPATCHER HOOK — one insert needed in dispatcher.js's dispatchJob(),
 * right after classifyJobType() resolves to "discover_scrape":
 *
 *   await supabase.from("search_log").insert({
 *     source: input.source, keyword: input.keyword, location: input.location || null,
 *   });
 */
