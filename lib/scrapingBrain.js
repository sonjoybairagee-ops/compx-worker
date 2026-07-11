/**
 * lib/scrapingBrain.js
 * TypeScript → JavaScript converted (removed type annotations)
 */

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * AI BRAIN - LAYER 1: FAST RULE ENGINE (REAL-TIME)
 */
export function analyzeJobRisk(ctx) {
  let risk = 0;
  const domain = (ctx.domain || "").toLowerCase();

  if (domain.includes("google"))                              risk += 3;
  if (domain.includes("linkedin"))                           risk += 3;
  if (domain.includes("yelp"))                               risk += 2;
  if (domain.includes("facebook") || domain.includes("instagram")) risk += 3;
  if ((ctx.previousFailures || 0) > 3)                       risk += 2;
  if (ctx.jobType === "maps" || ctx.jobType === "deep_scrape") risk += 2;

  const safe   = risk <= 2;
  const medium = risk <= 4;

  return {
    proxyScoreThreshold: safe ? 20 : medium ? 50 : 75,
    preferredGeo:        ctx.country || null,
    delayMs:             safe ? 800 : medium ? 2000 : 5000,
    retryStrategy:       safe ? "aggressive" : medium ? "normal" : "safe",
    confidence:          Math.max(0, 100 - (risk * 10)),
    riskLevel:           risk,
  };
}

/**
 * Adaptive Retry Engine
 */
export function getRetryPolicy(strategy) {
  if (strategy === "aggressive") return { retries: 1, delay: 500 };
  if (strategy === "normal")     return { retries: 3, delay: 2000 };
  return { retries: 5, delay: 5000 };
}

/**
 * AI BRAIN - LAYER 2: BACKGROUND LEARNING (ASYNC)
 */
export async function updateBrainFeedback({ proxyId, success, latency = 0, domain }) {
  try {
    if (proxyId) {
      if (success) {
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
      } else {
        await supabase.rpc("increment_column", {
          table_name:      "system_proxies",
          column_name:     "fail_count",
          row_id:          proxyId,
          increment_value: 1,
        });
      }
    }

    if (domain) {
      await supabase.rpc("increment_domain_stat", {
        p_domain:     domain,
        p_is_success: success,
        p_latency:    latency,
      });
    }
  } catch (err) {
    console.error("[ScrapingBrain] Feedback loop error:", err);
  }
}
