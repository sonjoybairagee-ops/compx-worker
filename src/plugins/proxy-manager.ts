export class ProxyManager {
  private cache: SystemProxy[] = [];
  private lastLoadedAt = 0;
  private readonly ttlMs: number;
  private isLoading = false; // Prevents concurrent load calls

  constructor(ttlMs = 60_000) {
    this.ttlMs = ttlMs;
  }

  async load(force = false): Promise<void> {
    // Prevent multiple simultaneous load attempts
    if (this.isLoading) return;
    
    // Check cache validity
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
        // CRITICAL FIX: Do NOT update lastLoadedAt on failure. 
        // This ensures the next call will retry fetching the proxies.
        return; 
      }

      // Only update cache and timestamp on SUCCESS
      this.cache = data || [];
      this.lastLoadedAt = Date.now();
      console.log(`[ProxyManager] Loaded ${this.cache.length} active proxies`);
      
    } finally {
      this.isLoading = false;
    }
  }

  private score(p: SystemProxy): number {
    // Solid heuristic: heavily penalize failures, reward success, slight penalty for high latency
    return (
      (p.success_count || 0) * 2 -
      (p.fail_count || 0) * 3 -
      (p.latency || 0) / 200
    );
  }

  async getBest(routing?: RoutingDecision): Promise<ScoredProxy | null> {
    await this.load();
    if (!this.cache.length) return null;

    let pool = this.cache;

    if (routing?.preferredGeo) {
      const geoPool = pool.filter((p) => p.geo === routing.preferredGeo);
      if (geoPool.length) pool = geoPool; // Only filter if we actually found matches
    }

    let scored: ScoredProxy[] = pool.map((p) => ({ ...p, score: this.score(p) }));

    if (routing?.minScore !== undefined) {
      const filtered = scored.filter((p) => p.score >= (routing.minScore as number));
      if (filtered.length) scored = filtered;
    }

    // Sort descending by score
    scored.sort((a, b) => b.score - a.score);
    
    return scored[0] || null;
  }

  async markSuccess(proxyId: string, latency: number): Promise<void> {
    try {
      // Using RPC is excellent for avoiding race conditions
      await getClient().rpc("increment_column", {
        table_name: "system_proxies",
        column_name: "success_count",
        row_id: proxyId,
        increment_value: 1,
      });
      
      await getClient()
        .from("system_proxies")
        .update({ 
          latency, // Note: Consider averaging this in DB if spikes are an issue
          last_used: new Date().toISOString() 
        })
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