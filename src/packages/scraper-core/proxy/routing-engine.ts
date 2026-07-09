/**
 * scraper-core/proxy/routing-engine.ts
 *
 * Replaces BOTH worker/lib/scrapingBrain.js::analyzeJobRisk() and
 * worker/lib/routingEngine.js::analyzeJobRisk() — the old codebase had two
 * different implementations of the same function name, one of them dead
 * code, and their outputs didn't even use the same field names (see the bug
 * note in proxy-manager.ts). This is the single replacement.
 *
 * Keeps scrapingBrain's per-keyword risk scoring (more granular) but emits
 * routingEngine's field name (`minScore`) so proxy-manager's filter actually
 * works.
 */

import type { RoutingDecision } from "./proxy-manager.js";

export interface RiskContext {
  domain?: string | null;
  website?: string | null;
  source?: string | null;
  country?: string | null;
  type?: string | null;
  previousFailures?: number;
}

const HIGH_RISK_KEYWORDS = ["google", "linkedin", "facebook", "instagram"];
const MEDIUM_RISK_KEYWORDS = ["yelp", "trustpilot", "yellowpages"];

const COUNTRY_GEO: Record<string, string> = {
  US: "us", CA: "us",
  GB: "eu", DE: "eu", FR: "eu", NL: "eu", SE: "eu",
  BD: "asia", IN: "asia", SG: "asia", JP: "asia", PK: "asia",
  AU: "au", NZ: "au",
};

export function analyzeJobRisk(ctx: RiskContext): RoutingDecision & { riskScore: number; confidence: number } {
  const target = (ctx.domain || ctx.website || "").toLowerCase();
  let riskScore = 0;

  if (HIGH_RISK_KEYWORDS.some((k) => target.includes(k))) riskScore += 3;
  if (MEDIUM_RISK_KEYWORDS.some((k) => target.includes(k))) riskScore += 2;
  if ((ctx.previousFailures || 0) > 3) riskScore += 2;
  if (ctx.type === "maps" || ctx.type === "deep_scrape" || ctx.type === "discover_scrape") riskScore += 1;

  const riskLevel: RoutingDecision["riskLevel"] =
    riskScore <= 2 ? "low" : riskScore <= 4 ? "medium" : "high";

  const preferredGeo = ctx.country ? COUNTRY_GEO[ctx.country.toUpperCase()] ?? null : null;

  // FIX: this is the field proxy-manager.ts actually reads — `minScore`,
  // not `proxyScoreThreshold` (the old scrapingBrain.js field that nothing
  // downstream ever matched against).
  const minScore = riskLevel === "high" ? 60 : riskLevel === "medium" ? 20 : 0;
  const delayMs = riskLevel === "high" ? 5000 : riskLevel === "medium" ? 2000 : 800;

  return {
    riskLevel,
    preferredGeo,
    minScore,
    delayMs,
    riskScore,
    confidence: Math.max(0, 100 - riskScore * 10),
  };
}
