/**
 * scraper-core/proxy/routing-engine.ts
 *
 * Replaces BOTH worker/lib/scrapingBrain.js::analyzeJobRisk() and
 * worker/lib/routingEngine.js::analyzeJobRisk() — the old codebase had two
 * different implementations of the same function name, one of them dead
 * code, and their outputs didn't even use the same field names.
 *
 * Keeps scrapingBrain's per-keyword risk scoring (more granular) but emits
 * routingEngine's field name (`minScore`) so proxy-manager's filter actually works.
 */

import type { RoutingDecision } from "./proxy-manager.js";

export interface RiskContext {
  domain?: string | null;
  website?: string | null;
  source?: string | null; // e.g., "instagram", "linkedin", "youtube"
  country?: string | null;
  type?: string | null; // e.g., "discover_scrape", "deep_scrape"
  previousFailures?: number;
}

const HIGH_RISK_SOURCES = ["linkedin", "instagram", "facebook"];
const HIGH_RISK_KEYWORDS = ["google", "linkedin", "facebook", "instagram"];
const MEDIUM_RISK_KEYWORDS = ["yelp", "trustpilot", "yellowpages", "twitter", "x.com"];

const COUNTRY_GEO: Record<string, string> = {
  US: "us", CA: "us",
  GB: "eu", DE: "eu", FR: "eu", NL: "eu", SE: "eu",
  BD: "asia", IN: "asia", SG: "asia", JP: "asia", PK: "asia",
  AU: "au", NZ: "au",
};

export function analyzeJobRisk(ctx: RiskContext): RoutingDecision & { riskScore: number; confidence: number } {
  // ✅ FIX 1: Include ctx.source in the target check so plugin-provided sources are evaluated
  const target = (ctx.source || ctx.domain || ctx.website || "").toLowerCase();
  let riskScore = 0;

  // Check source first (highest priority)
  if (HIGH_RISK_SOURCES.some((k) => target.includes(k))) {
    riskScore += 4; // Heavy penalty for known strict platforms
  } else if (HIGH_RISK_KEYWORDS.some((k) => target.includes(k))) {
    riskScore += 3;
  }
  
  if (MEDIUM_RISK_KEYWORDS.some((k) => target.includes(k))) riskScore += 2;
  if ((ctx.previousFailures || 0) > 3) riskScore += 2;
  if (ctx.type === "maps" || ctx.type === "deep_scrape" || ctx.type === "discover_scrape") riskScore += 1;

  const riskLevel: RoutingDecision["riskLevel"] =
    riskScore <= 2 ? "low" : riskScore <= 4 ? "medium" : "high";

  const preferredGeo = ctx.country ? COUNTRY_GEO[ctx.country.toUpperCase()] ?? null : null;

  // ✅ FIX 2: Align minScore with proxy-manager.ts scoring formula: (success*2) - (fail*3) - (latency/200)
  // A score of 10 means the proxy has roughly 5 more successes than failures, which is safe for high risk.
  const minScore = riskLevel === "high" ? 10 : riskLevel === "medium" ? 0 : -10;
  
  // Delay in ms before making the request
  const delayMs = riskLevel === "high" ? 4000 : riskLevel === "medium" ? 2000 : 800;

  return {
    riskLevel,
    preferredGeo,
    minScore,
    delayMs,
    riskScore,
    confidence: Math.max(0, 100 - riskScore * 15),
  };
}