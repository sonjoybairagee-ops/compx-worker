// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any; // Avoid cross-package @supabase version conflict
import { CACHE_CONFIG } from "./cache.js";

export async function getCachedScrape(
  supabase: AnySupabase,
  source: string,
  target: string,
  version: string = "v1",
  logger?: any
): Promise<{ hit: boolean; data?: any[] }> {
  try {
    const { data, error } = await supabase
      .from("scrape_cache")
      .select("raw_data, updated_at")
      .eq("source", source)
      .eq("target", target)
      .eq("version", version)
      .single();

    if (error || !data) return { hit: false };

    // Check TTL (14 days)
    const updated = new Date(data.updated_at).getTime();
    const now = Date.now();
    const daysOld = (now - updated) / (1000 * 60 * 60 * 24);

    if (daysOld > CACHE_CONFIG.DEFAULT_TTL_DAYS) {
      if (logger) await logger.log(`Cache for ${target} expired (${Math.round(daysOld)} days old)`);
      return { hit: false };
    }

    // Parse Data (Corruption Check)
    let parsedData = data.raw_data;
    if (typeof parsedData === "string") {
      try {
        parsedData = JSON.parse(parsedData);
      } catch (err) {
        if (logger) await logger.log(`Cache corruption detected for ${target}. Recovering (Live Scrape)...`);
        // Delete corrupted cache
        await supabase.from("scrape_cache").delete().eq("source", source).eq("target", target).eq("version", version);
        return { hit: false };
      }
    }

    if (!Array.isArray(parsedData) && typeof parsedData !== "object") {
      if (logger) await logger.log(`Cache corruption detected (invalid format) for ${target}. Recovering (Live Scrape)...`);
      await supabase.from("scrape_cache").delete().eq("source", source).eq("target", target).eq("version", version);
      return { hit: false };
    }

    if (logger) await logger.log(`✓ Cache Hit: ${target} (v${version})`);
    return { hit: true, data: parsedData };
  } catch (err) {
    return { hit: false };
  }
}

export async function setCachedScrape(
  supabase: AnySupabase,
  source: string,
  target: string,
  rawData: any,
  version: string = "v1"
): Promise<void> {
  try {
    const { error } = await supabase
      .from("scrape_cache")
      .upsert(
        {
          source,
          target,
          version,
          raw_data: rawData,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'source,target,version' }
      );
    if (error) {
      console.error(`[Cache] Failed to save cache for ${source}:${target}`, error.message);
    }
  } catch (err) {
    console.error(`[Cache] Error saving cache for ${source}:${target}`, err);
  }
}
