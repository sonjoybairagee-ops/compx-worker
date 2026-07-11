/**
 * lib/proxy.js
 * TypeScript → JavaScript converted
 */

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase    = createClient(supabaseUrl, supabaseKey);

let proxyCache = [];

export async function loadProxies() {
  try {
    const { data, error } = await supabase
      .from("system_proxies")
      .select("*")
      .eq("status", "active");

    if (error) {
      console.error("[ProxyManager] Failed to load proxies:", error.message);
      return;
    }

    if (data) {
      proxyCache = data;
      console.log(`[ProxyManager] Loaded ${proxyCache.length} active proxies`);
    }
  } catch (err) {
    console.error("[ProxyManager] loadProxies error:", err);
  }
}

function calculateScore(p) {
  return (
    (p.success_count || 0) * 2 -
    (p.fail_count    || 0) * 3 -
    (p.latency       || 0) / 200
  );
}

export function getBestProxy(routing) {
  if (!proxyCache.length) return null;

  let pool = [...proxyCache];

  // Geo filter
  if (routing?.preferredGeo) {
    const geoPool = pool.filter(p => p.geo === routing.preferredGeo);
    if (geoPool.length) pool = geoPool;
  }

  let scoredPool = pool.map(p => ({ ...p, score: calculateScore(p) }));

  // Min score filter
  if (routing?.minScore !== undefined) {
    const filtered = scoredPool.filter(p => p.score >= routing.minScore);
    if (filtered.length) scoredPool = filtered;
  }

  scoredPool.sort((a, b) => b.score - a.score);
  return scoredPool[0] || null;
}

export async function markProxyFail(proxyId) {
  try {
    await supabase.rpc("increment_column", {
      table_name:      "system_proxies",
      column_name:     "fail_count",
      row_id:          proxyId,
      increment_value: 1,
    });
  } catch (err) {
    console.error("[ProxyManager] markProxyFail error:", err);
  }
}

export async function markProxySuccess(proxyId, latency) {
  try {
    await supabase.rpc("increment_column", {
      table_name:      "system_proxies",
      column_name:     "success_count",
      row_id:          proxyId,
      increment_value: 1,
    });
    await supabase
      .from("system_proxies")
      .update({ latency, last_used: new Date().toISOString() })
      .eq("id", proxyId);
  } catch (err) {
    console.error("[ProxyManager] markProxySuccess error:", err);
  }
}
