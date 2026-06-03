import { createClient } from "@supabase/supabase-js";

// Same initialization as proxy.ts
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

export interface ScrapingContext {
  domain?: string;
  country?: string;
  jobType?: string;
  previousFailures?: number;
}

export interface BrainDecision {
  proxyScoreThreshold: number;
  preferredGeo: string | null;
  delayMs: number;
  retryStrategy: "aggressive" | "normal" | "safe";
  confidence: number;
  riskLevel: number;
}

/**
 * AI BRAIN - LAYER 1: FAST RULE ENGINE (REAL-TIME)
 * Analyzes risk deterministically to route to the best proxy pool.
 */
export function analyzeJobRisk(ctx: ScrapingContext): BrainDecision {
  let risk = 0;
  const domain = (ctx.domain || "").toLowerCase();

  // 1. Domain Risk Rules
  if (domain.includes("google")) risk += 3;
  if (domain.includes("linkedin")) risk += 3;
  if (domain.includes("yelp")) risk += 2;
  if (domain.includes("facebook") || domain.includes("instagram")) risk += 3;

  // 2. Failure History
  if ((ctx.previousFailures || 0) > 3) risk += 2;

  // 3. Job Type Risk
  if (ctx.jobType === "maps" || ctx.jobType === "deep_scrape") risk += 2;

  const safe = risk <= 2;
  const medium = risk <= 4;

  return {
    proxyScoreThreshold: safe ? 20 : medium ? 50 : 75,
    preferredGeo: ctx.country || null,
    delayMs: safe ? 800 : medium ? 2000 : 5000,
    retryStrategy: safe ? "aggressive" : medium ? "normal" : "safe",
    confidence: Math.max(0, 100 - (risk * 10)),
    riskLevel: risk
  };
}

/**
 * Adaptive Retry Engine based on Brain Decision
 */
export function getRetryPolicy(strategy: "aggressive" | "normal" | "safe") {
  if (strategy === "aggressive") {
    return { retries: 1, delay: 500 };
  }
  if (strategy === "normal") {
    return { retries: 3, delay: 2000 };
  }
  return { retries: 5, delay: 5000 }; // safe = maximum backoff
}

/**
 * AI BRAIN - LAYER 2: BACKGROUND LEARNING (ASYNC)
 * Safe asynchronous feedback loop. DOES NOT BLOCK SCRAPING.
 */
export async function updateBrainFeedback({
  proxyId,
  success,
  latency = 0,
  domain,
}: {
  proxyId: string | null;
  success: boolean;
  latency?: number;
  domain?: string;
}) {
  try {
    // 1. Update Proxy Stats safely via RPC
    if (proxyId) {
      if (success) {
        // We can reuse the markProxySuccess/Fail logic from proxy.ts, but keeping it unified here is better for the brain
        await supabase.rpc("increment_column", {
          table_name: "system_proxies",
          column_name: "success_count",
          row_id: proxyId,
          increment_value: 1
        });
        
        await supabase
          .from("system_proxies")
          .update({
            latency: latency,
            last_used: new Date().toISOString()
          })
          .eq("id", proxyId);
      } else {
        await supabase.rpc("increment_column", {
          table_name: "system_proxies",
          column_name: "fail_count",
          row_id: proxyId,
          increment_value: 1
        });
      }
    }

    // 2. Update Domain Stats safely via new RPC (Background Learning)
    if (domain) {
      await supabase.rpc("increment_domain_stat", {
        p_domain: domain,
        p_is_success: success,
        p_latency: latency
      });
    }

  } catch (err) {
    console.error("[ScrapingBrain] Failed to update feedback loop:", err);
  }
}
