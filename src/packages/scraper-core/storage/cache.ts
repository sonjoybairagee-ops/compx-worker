import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { CACHE_CONFIG } from "../cache.js"; // Note: adjust path if cache.ts is in scraper-core/

export function buildCacheKey(source: string, params: Record<string, any>): string {
  const normalized = Object.keys(params)
    .sort()
    .reduce((acc, k) => {
      const v = params[k];
      acc[k] = typeof v === "string" ? v.trim().toLowerCase() : v;
      return acc;
    }, {} as Record<string, any>);

  return createHash("sha1").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
}

export class ScrapeCache {
  constructor(private supabase: SupabaseClient) {}

  async get<T = any>(source: string, params: Record<string, any>, version: string = "v1", logger?: any): Promise<T | null> {
    const target = buildCacheKey(source, params);
    try {
      const { data, error } = await this.supabase
        .from("scrape_cache")
        .select("raw_data, updated_at")
        .eq("source", source)
        .eq("target", target)
        .eq("version", version)
        .single();

      if (error || !data) return null;

      const updated = new Date(data.updated_at).getTime();
      const now = Date.now();
      const daysOld = (now - updated) / (1000 * 60 * 60 * 24);

      if (daysOld > CACHE_CONFIG.DEFAULT_TTL_DAYS) {
        if (logger) await logger.log(`Cache for ${target} expired (${Math.round(daysOld)} days old)`);
        return null;
      }

      let parsedData = data.raw_data;
      if (typeof parsedData === "string") {
        try {
          parsedData = JSON.parse(parsedData);
        } catch (err) {
          if (logger) await logger.log(`Cache corruption detected for ${target}. Recovering (Live Scrape)...`);
          await this.invalidate(source, params, version);
          return null;
        }
      }

      if (logger) await logger.log(`✓ Cache Hit: ${target} (v${version})`);
      return parsedData as T;
    } catch (err: any) {
      if (logger) await logger.log(`[ScrapeCache] get error: ${err.message}`);
      return null;
    }
  }

  async set(source: string, params: Record<string, any>, value: any, version: string = "v1"): Promise<void> {
    const target = buildCacheKey(source, params);
    try {
      const { error } = await this.supabase
        .from("scrape_cache")
        .upsert(
          {
            source,
            target,
            version,
            raw_data: value,
            updated_at: new Date().toISOString()
          },
          { onConflict: 'source,target,version' }
        );
      if (error) {
        console.error(`[ScrapeCache] Failed to save cache for ${source}:${target}`, error.message);
      }
    } catch (err: any) {
      console.error(`[ScrapeCache] set error:`, err.message);
    }
  }

  async invalidate(source: string, params: Record<string, any>, version: string = "v1"): Promise<void> {
    const target = buildCacheKey(source, params);
    try {
      await this.supabase
        .from("scrape_cache")
        .delete()
        .eq("source", source)
        .eq("target", target)
        .eq("version", version);
    } catch (_) {}
  }
}

let shared: ScrapeCache | null = null;
export function getScrapeCache(supabase: SupabaseClient): ScrapeCache {
  if (!shared) shared = new ScrapeCache(supabase);
  return shared;
}
