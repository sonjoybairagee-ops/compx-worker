/**
 * scraper-core/proxy/proxy-manager.ts
 *
 * Consolidates worker/lib/proxy.js + worker/lib/scrapingBrain.js's proxy
 * scoring into one module, and fixes a real bug found during migration:
 *
 *   BUG: lib/scrapingBrain.js::analyzeJobRisk() returned `proxyScoreThreshold`,
 *   but lib/proxy.js::getBestProxy() read `routing.minScore` — the field
 *   names never matched, so the min-score proxy filter silently never
 *   applied in production.
 *
 *   FIX: this module defines one RoutingDecision shape with `minScore`, and
 *   the risk engine must produce it.
 *
 *   FIX (Node 20 RealtimeClient WebSocket warning): pass `ws` as the 
 *   realtime transport for Node < 22 to prevent DLQ failures.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import ws from "ws";

export interface SystemProxy {
  id: string;
  server?: string;
  geo?: string;
  success_count?: number;
  fail_count?: number;
  latency?: number;
  status?: string;
  [key: string]: any;
}

export interface RoutingDecision {
  riskLevel: "low" | "medium" | "high";
  preferredGeo?: string | null;
  /** Minimum proxy score required to be eligible for selection. */
  minScore?: number;
  delayMs: number;
}

export interface ScoredProxy extends SystemProxy {
  score: number;
}

let cachedClient: SupabaseClient | null = null;
function getClient(): SupabaseClient {
  if (cachedClient) return cachedClient;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  cachedClient = createClient(url, key, {
    realtime: {
      transport: ws as any,
    },
  });
  return cachedClient;
}

export class ProxyManager {
  private cache: SystemProxy[] = [];
  private lastLoadedAt = 0;
  private readonly ttlMs: number;
  private isLoading = false; // ✅ FIX: Prevent concurrent load attempts (thundering herd)

  constructor(ttlMs = 60_000) {
    this.ttlMs = ttlMs;
  }

  async load(force = false): Promise<void> {
    // 1. If already loading, wait briefly for it to finish
    if (this.isLoading) {
      while (this.isLoading) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return;
    }

    // 2. Check cache validity
    if (!force && this.cache.length > 0 && Date.now() - this.lastLoadedAt < this.ttlMs) {
      return;
    }

    this.isLoading = true;
    try {
      const { data, error } = await getClient()
        .from("system_proxies")
        .select("*")
        .eq("status", "active");

      if (error) {
        console.error("[ProxyManager] Failed to load proxies:", error.message);
        // ✅ CRITICAL FIX: Do NOT update lastLoadedAt on failure.
        // This ensures the next call will retry fetching the proxies.
        return;
      }

      // 3. Only update cache and timestamp on SUCCESS
      this.cache = data || [];
      this.lastLoadedAt = Date.now();
      console.log(`[ProxyManager] Loaded ${this.cache.length} active proxies`);
    } finally {
      this.isLoading = false;
    }
  }

  private score(p: SystemProxy): number {
    return (
      (p.success_count || 0) * 2 -
      (p.fail_count || 0) * 3 -
      (p.latency || 0) / 200
    );
  }

  /** Best proxy for a routing decision. Auto-refreshes the cache if stale. */
  async getBest(routing?: RoutingDecision): Promise<ScoredProxy | null> {
    await this.load();
    if (!this.cache.length) return null;

    let pool = this.cache;

    if (routing?.preferredGeo) {
      const geoPool = pool.filter((p) => p.geo === routing.preferredGeo);
      if (geoPool.length) pool = geoPool;
    }

    let scored: ScoredProxy[] = pool.map((p) => ({ ...p, score: this.score(p) }));

    // FIX: this is the corrected field — `minScore`, matching RoutingDecision
    if (routing?.minScore !== undefined) {
      const filtered = scored.filter((p) => p.score >= (routing.minScore as number));
      if (filtered.length) scored = filtered;
    }

    scored.sort((a, b) => b.score - a.score);
    return scored[0] || null;
  }

  async markSuccess(proxyId: string, latency: number): Promise<void> {
    try {
      await getClient().rpc("increment_column", {
        table_name: "system_proxies",
        column_name: "success_count",
        row_id: proxyId,
        increment_value: 1,
      });
      await getClient()
        .from("system_proxies")
        .update({ latency, last_used: new Date().toISOString() })
        .eq("id", proxyId);
    } catch (err: any) {
      console.error("[ProxyManager] markSuccess error:", err.message);
    }
  }

  async markFail(proxyId: string): Promise<void> {
    try {
      await getClient().rpc("increment_column", {
        table_name: "system_proxies",
        column_name: "fail_count",
        row_id: proxyId,
        increment_value: 1,
      });
    } catch (err: any) {
      console.error("[ProxyManager] markFail error:", err.message);
    }
  }
}

// ── Singleton — shared cache across all plugins in this worker process ────────
let shared: ProxyManager | null = null;
export function getProxyManager(): ProxyManager {
  if (!shared) shared = new ProxyManager();
  return shared;
}