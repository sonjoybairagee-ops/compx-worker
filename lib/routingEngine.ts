/**
 * CompX — src/lib/routingEngine.ts
 * Geo + Domain risk aware routing decisions
 */

export type RiskLevel = "low" | "medium" | "high";

export interface JobRoutingContext {
  domain?: string;
  website?: string;
  country?: string; // "US", "BD", "DE" etc.
  source?: string;  // "google_maps", "yellow_pages" etc.
  type?: string;    // "enrich", "deep_scrape", "verify_email"
}

export interface RoutingDecision {
  riskLevel: RiskLevel;
  preferredGeo: string | null;
  minScore: number;
  delayMs: number;
}

// Domain keyword → risk level
const DOMAIN_RISK: Array<[string, RiskLevel]> = [
  ["google.com",    "high"],
  ["maps.google",   "high"],
  ["linkedin.com",  "high"],
  ["facebook.com",  "high"],
  ["instagram.com", "high"],
  ["twitter.com",   "medium"],
  ["x.com",         "medium"],
  ["yelp.com",      "medium"],
  ["trustpilot.com","medium"],
  ["yellowpages",   "medium"],
];

// Source → risk level override
const SOURCE_RISK: Record<string, RiskLevel> = {
  google_maps:  "high",
  "google maps":"high",
  yellow_pages: "medium",
  "yellow pages":"medium",
};

// Country code → geo region
const COUNTRY_GEO: Record<string, string> = {
  US: "us", CA: "us",
  GB: "eu", DE: "eu", FR: "eu", NL: "eu", SE: "eu",
  BD: "asia", IN: "asia", SG: "asia", JP: "asia", PK: "asia",
  AU: "au", NZ: "au",
};

export function analyzeJobRisk(ctx: JobRoutingContext): RoutingDecision {
  const riskLevel   = getRiskLevel(ctx);
  const preferredGeo = ctx.country ? (COUNTRY_GEO[ctx.country.toUpperCase()] ?? null) : null;

  // High-risk jobs need better proxies
  const minScore = riskLevel === "high" ? 60 : riskLevel === "medium" ? 20 : 0;

  // Delay between requests — protect against bot detection
  const delayMs = riskLevel === "high" ? 5000 : riskLevel === "medium" ? 2000 : 800;

  return { riskLevel, preferredGeo, minScore, delayMs };
}

function getRiskLevel(ctx: JobRoutingContext): RiskLevel {
  // Source override takes priority (e.g. google_maps is always high)
  if (ctx.source) {
    const sourceRisk = SOURCE_RISK[ctx.source.toLowerCase()];
    if (sourceRisk) return sourceRisk;
  }

  // Check domain/website
  const target = (ctx.domain || ctx.website || "").toLowerCase().replace(/^www\./, "");
  if (target) {
    for (const [keyword, risk] of DOMAIN_RISK) {
      if (target.includes(keyword)) return risk;
    }
  }

  return "low";
}
