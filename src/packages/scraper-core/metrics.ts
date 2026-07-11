/**
 * scraper-core/metrics.ts
 *
 * Per-provider health metrics, separate from circuitBreaker.ts.
 * circuitBreaker.ts answers "should we route traffic to this provider right
 * now" (a pass/fail sliding window). This module answers "how healthy has
 * this provider been" for humans looking at a dashboard: success rate,
 * average latency, call volume, in rolling 24h buckets.
 *
 * Storage: a capped Redis list per provider per hour-bucket. Cheap to write,
 * cheap to read back for the last N hours. If Redis is unavailable this is
 * entirely best-effort — it never throws and never blocks the scrape.
 */

type Redis = any;

const METRICS_TTL_SECONDS = 60 * 60 * 26; // keep each hour-bucket ~26h
const MAX_SAMPLES_PER_BUCKET = 500;

function hourBucket(d = new Date()): string {
  return d.toISOString().slice(0, 13); // e.g. "2026-07-10T14"
}

export interface ProviderMetricSample {
  success: boolean;
  latencyMs: number;
  cost?: number;
}

export async function recordProviderMetric(provider: string, sample: ProviderMetricSample, redis: Redis): Promise<void> {
  if (!redis) return;
  try {
    const key = `metrics:provider:${provider}:${hourBucket()}`;
    const payload = JSON.stringify({ ...sample, ts: Date.now() });
    await redis.lpush(key, payload);
    await redis.ltrim(key, 0, MAX_SAMPLES_PER_BUCKET - 1);
    await redis.expire(key, METRICS_TTL_SECONDS);
  } catch (err) {
    console.warn(`[metrics] failed to record sample for ${provider}:`, err);
  }
}

export interface ProviderMetricSummary {
  provider: string;
  calls: number;
  successRate: number;
  avgLatencyMs: number;
}

/** Reads back the last `hours` worth of buckets and summarizes. Used by an admin/dashboard endpoint, not by the hot scrape path. */
export async function getProviderMetrics(provider: string, redis: Redis, hours = 24): Promise<ProviderMetricSummary> {
  const empty = { provider, calls: 0, successRate: 0, avgLatencyMs: 0 };
  if (!redis) return empty;

  try {
    const now = new Date();
    const samples: ProviderMetricSample[] = [];
    for (let i = 0; i < hours; i++) {
      const bucketTime = new Date(now.getTime() - i * 60 * 60 * 1000);
      const key = `metrics:provider:${provider}:${hourBucket(bucketTime)}`;
      const raw: string[] = await redis.lrange(key, 0, -1);
      for (const r of raw) {
        try {
          samples.push(JSON.parse(r));
        } catch {
          /* skip corrupt sample */
        }
      }
    }

    if (samples.length === 0) return empty;

    const successes = samples.filter((s) => s.success).length;
    const totalLatency = samples.reduce((sum, s) => sum + (s.latencyMs || 0), 0);

    return {
      provider,
      calls: samples.length,
      successRate: successes / samples.length,
      avgLatencyMs: Math.round(totalLatency / samples.length),
    };
  } catch (err) {
    console.warn(`[metrics] failed to read metrics for ${provider}:`, err);
    return empty;
  }
}
