import { createClient } from "@supabase/supabase-js";
import { RoutingDecision } from "./routingEngine";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

let proxyCache: any[] = [];

/**
 * Loads all active proxies from Supabase into memory with their stats.
 */
export async function loadProxies() {
  try {
    const { data, error } = await supabase
      .from("system_proxies")
      .select("*")
      .eq("status", "active");

    if (error) {
      console.error("[ProxyManager] Failed to load proxies from DB:", error.message);
      return;
    }

    if (data) {
      proxyCache = data;
      console.log(`[ProxyManager] Loaded ${proxyCache.length} active proxies into smart cache.`);
    }
  } catch (err) {
    console.error("[ProxyManager] Exception in loadProxies:", err);
  }
}

function calculateScore(p: any) {
  return (
    (p.success_count || 0) * 2 -
    (p.fail_count || 0) * 3 -
    (p.latency || 0) / 200
  );
}

/**
 * Gets the best proxy using Smart Scoring + Geo + Risk filtering.
 */
export function getBestProxy(routing?: Partial<RoutingDecision>): any | null {
  if (!proxyCache.length) {
    return null; // FAIL SAFE instead of crash
  }

  let pool = [...proxyCache];

  // GEO filter
  if (routing?.preferredGeo) {
    const geoPool = pool.filter(p => p.geo === routing.preferredGeo);
    if (geoPool.length) pool = geoPool;
  }

  // Attach scores ONCE
  let scoredPool = pool.map(p => ({
    ...p,
    score: calculateScore(p),
  }));

  // minScore filter
  if (routing?.minScore !== undefined) {
    const filtered = scoredPool.filter(p => p.score >= routing.minScore!);
    if (filtered.length) scoredPool = filtered;
  }

  // final ranking
  scoredPool.sort((a, b) => b.score - a.score);

  return scoredPool[0] || null;
}

/**
 * Marks a proxy as failed using atomic RPC increment.
 */
export async function markProxyFail(proxyId: string) {
  try {
    await supabase.rpc("increment_column", {
      table_name: "system_proxies",
      column_name: "fail_count",
      row_id: proxyId,
      increment_value: 1
    });
  } catch (err) {
    console.error("[ProxyManager] Error marking proxy fail:", err);
  }
}

/**
 * Marks a proxy as successful, updates latency and timestamp.
 */
export async function markProxySuccess(proxyId: string, latency: number) {
  try {
    // Increment success_count
    await supabase.rpc("increment_column", {
      table_name: "system_proxies",
      column_name: "success_count",
      row_id: proxyId,
      increment_value: 1
    });

    // Update latency and last_used
    await supabase
      .from("system_proxies")
      .update({
        latency: latency,
        last_used: new Date().toISOString()
      })
      .eq("id", proxyId);
  } catch (err) {
    console.error("[ProxyManager] Error marking proxy success:", err);
  }
}
