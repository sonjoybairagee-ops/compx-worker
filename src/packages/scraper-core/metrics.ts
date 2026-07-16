/**
 * scraper-core/metrics.ts
 *
 * Per-provider health metrics for dashboard/monitoring.
 * Fully adapted for Supabase-only architecture (No Redis).
 * Uses a dedicated 'provider_metrics' table with hourly bucketing.
 */

import { createClient } from "@supabase/supabase-js";
import ws from "ws";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

export interface ProviderMetricSample {
  success: boolean;
  latencyMs: number;
  cost?: number;
}

export interface ProviderMetricSummary {
  provider: string;
  calls: number;
  successRate: number;
  avgLatencyMs: number;
}

let cachedClient: AnySupabase | null = null;
function getSupabase(): AnySupabase {
  if (cachedClient) return cachedClient;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  cachedClient = createClient(url, key, { realtime: { transport: ws as any } });
  return cachedClient;
}

function hourBucket(d = new Date()): string {
  return d.toISOString().slice(0, 13); // e.g. "2026-07-10T14"
}

/**
 * Records a single metric sample into the current hour's bucket.
 * Uses upsert to atomically append to the JSONB array without race conditions.
 */
export async function recordProviderMetric(provider: string, sample: ProviderMetricSample): Promise<void> {
  try {
    const supabase = getSupabase();
    const bucket = hourBucket();
    const payload = { ...sample, ts: Date.now() };

    // Atomic upsert that appends to existing samples array
    const { error } = await supabase.rpc("upsert_provider_metric", {
      p_provider: provider,
      p_bucket: bucket,
      p_sample: payload,
    });

    if (error) {
      console.warn(`[metrics] failed to record sample for ${provider}:`, error.message);
    }
  } catch (err: any) {
    console.warn(`[metrics] unexpected error recording metric for ${provider}:`, err.message);
  }
}

/**
 * Reads back the last N hours of buckets and summarizes.
 * Used by admin/dashboard endpoint — never blocks hot scrape path.
 */
export async function getProviderMetrics(
  provider: string,
  hours = 24
): Promise<ProviderMetricSummary> {
  const empty: ProviderMetricSummary = { 
    provider, 
    calls: 0, 
    successRate: 0, 
    avgLatencyMs: 0 
  };

  try {
    const supabase = getSupabase();
    const now = new Date();
    let totalSamples: ProviderMetricSample[] = [];

    // Fetch each hour bucket individually (avoids massive IN queries)
    for (let i = 0; i < hours; i++) {
      const bucketTime = new Date(now.getTime() - i * 60 * 60 * 1000);
      const bucket = hourBucket(bucketTime);

      const { data } = await supabase
        .from("provider_metrics")
        .select("samples")
        .eq("provider", provider)
        .eq("bucket", bucket)
        .single();

      if (data?.samples && Array.isArray(data.samples)) {
        totalSamples = totalSamples.concat(data.samples);
      }
    }

    if (totalSamples.length === 0) return empty;

    const successes = totalSamples.filter((s) => s.success).length;
    const totalLatency = totalSamples.reduce((sum, s) => sum + (s.latencyMs || 0), 0);

    return {
      provider,
      calls: totalSamples.length,
      successRate: parseFloat((successes / totalSamples.length).toFixed(4)),
      avgLatencyMs: Math.round(totalLatency / totalSamples.length),
    };
  } catch (err: any) {
    console.warn(`[metrics] failed to read metrics for ${provider}:`, err.message);
    return empty;
  }
}