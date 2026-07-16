import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "crypto";

// Safe fallback if CACHE_CONFIG is not yet defined or missing the property
const DEFAULT_TTL_DAYS = 30; 
let CACHE_TTL = DEFAULT_TTL_DAYS;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cacheConfig = require("../cache.js"); // Or adjust path to your cache.ts
  if (cacheConfig?.CACHE_CONFIG?.DEFAULT_TTL_DAYS) {
    CACHE_TTL = cacheConfig.CACHE_CONFIG.DEFAULT_TTL_DAYS;
  }
} catch {
  // Silently fall back to DEFAULT_TTL_DAYS if file doesn't exist yet
}

export function buildCacheKey(source: string, params: Record<string, any>): string {
  const normalized = Object.keys(params)
    .sort()
    .reduce((acc, k) => {
      const v = params[k];
      // ✅ FIX: Only trim strings. Do NOT lowercase, as some IDs/URLs are case-sensitive.
      acc[k] = typeof v === "string" ? v.trim() : v;
      return acc;
    }, {} as Record<string, any>);

  return createHash("sha1").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
}

export class ScrapeCache {
  constructor(private supabase: SupabaseClient) {}

  async get<T = any>(
    source: string, 
    params: Record<string, any>, 
    version: string = "v1", 
    logger?: any
  ): Promise<{ hit: boolean; data: T | null }> {
    const target = buildCacheKey(source, params);
    
    try {
      const { data, error } = await this.supabase
        .from("scrape_cache")
        .select("raw_data, updated_at")
        .eq("source", source)
        .eq("target", target)
        .eq("version", version)
        .single();

      if (error || !data) {
        return { hit: false, data: null };
      }

      const updated = new Date(data.updated_at).getTime();
      const now = Date.now();
      const daysOld = (now - updated) / (1000 * 60 * 60 * 24);

      // ✅ FIX: Read-Repair Pattern. If expired, delete it to prevent DB bloat.
      if (daysOld > CACHE_TTL) {
        if (logger) await logger.log(`⚠ Cache for ${target} expired (${Math.round(daysOld)} days old). Invalidating...`);
        await this.invalidate(source, params, version);
        return { hit: false, data: null };
      }

      let parsedData = data.raw_data;
      
      // Handle both JSONB (object) and Text (string) column types gracefully
      if (typeof parsedData === "string") {
        try {
          parsedData = JSON.parse(parsedData);
        } catch (err) {
          if (logger) await logger.log(`❌ Cache corruption detected for ${target}. Invalidating and triggering live scrape...`);
          await this.invalidate(source, params, version);
          return { hit: false, data: null };
        }
      }

      if (logger) await logger.log(`✅ Cache Hit: ${target} (v${version}, ${Math.round(daysOld)} days old)`);
      return { hit: true, data: parsedData as T };
      
    } catch (err: any) {
      if (logger) await logger.log(`[ScrapeCache] get error: ${err.message}`);
      return { hit: false, data: null };
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
            raw_data: value, // PostgREST handles JS objects natively if column is jsonb
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
    } catch (err: any) {
      console.error(`[ScrapeCache] invalidate error:`, err.message);
    }
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────
let sharedCache: ScrapeCache | null = null;

export function getScrapeCache(supabase: SupabaseClient): ScrapeCache {
  if (!sharedCache) {
    sharedCache = new ScrapeCache(supabase);
  }
  return sharedCache;
}

// Helper wrappers to match your plugin's expected signature (hit, data)
export async function getCachedScrape(supabase: SupabaseClient, source: string, targetParams: string | Record<string, any>, version: string, logger?: any) {
  const params = typeof targetParams === 'string' ? { query: targetParams } : targetParams;
  return await getScrapeCache(supabase).get(source, params, version, logger);
}

export async function setCachedScrape(supabase: SupabaseClient, source: string, targetParams: string | Record<string, any>, value: any, version: string) {
  const params = typeof targetParams === 'string' ? { query: targetParams } : targetParams;
  await getScrapeCache(supabase).set(source, params, value, version);
}