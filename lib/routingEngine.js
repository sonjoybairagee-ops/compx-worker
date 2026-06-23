/**
 * lib/routingEngine.js
 * TypeScript → JavaScript converted
 */

const DOMAIN_RISK = [
  ["google.com",     "high"],
  ["maps.google",    "high"],
  ["linkedin.com",   "high"],
  ["facebook.com",   "high"],
  ["instagram.com",  "high"],
  ["twitter.com",    "medium"],
  ["x.com",          "medium"],
  ["yelp.com",       "medium"],
  ["trustpilot.com", "medium"],
  ["yellowpages",    "medium"],
];

const SOURCE_RISK = {
  google_maps:   "high",
  "google maps": "high",
  yellow_pages:  "medium",
  "yellow pages":"medium",
};

const COUNTRY_GEO = {
  US: "us", CA: "us",
  GB: "eu", DE: "eu", FR: "eu", NL: "eu", SE: "eu",
  BD: "asia", IN: "asia", SG: "asia", JP: "asia", PK: "asia",
  AU: "au",  NZ: "au",
};

export function analyzeJobRisk(ctx) {
  const riskLevel    = getRiskLevel(ctx);
  const preferredGeo = ctx.country ? (COUNTRY_GEO[ctx.country.toUpperCase()] ?? null) : null;
  const minScore     = riskLevel === "high" ? 60 : riskLevel === "medium" ? 20 : 0;
  const delayMs      = riskLevel === "high" ? 5000 : riskLevel === "medium" ? 2000 : 800;

  return { riskLevel, preferredGeo, minScore, delayMs };
}

function getRiskLevel(ctx) {
  if (ctx.source) {
    const sourceRisk = SOURCE_RISK[ctx.source.toLowerCase()];
    if (sourceRisk) return sourceRisk;
  }

  const target = (ctx.domain || ctx.website || "").toLowerCase().replace(/^www\./, "");
  if (target) {
    for (const [keyword, risk] of DOMAIN_RISK) {
      if (target.includes(keyword)) return risk;
    }
  }

  return "low";
}
