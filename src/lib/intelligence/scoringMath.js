/**
 * Shared core for the hiring-signal search jobs (manual + scheduled).
 *
 * IMPORTANT: this replaces the continuous weighted-average scoring model
 * from round 2. That model is discarded — it doesn't match the scoring
 * that already existed in this codebase (lib/intelligence/scoring.ts),
 * which uses a simple boolean-flag formula:
 *   score = base_score
 *         + (is_hiring        ? hiring_weight     : 0)
 *         + (has_target_tech  ? tech_stack_weight : 0)
 *         + (high_traffic     ? traffic_weight    : 0)
 *
 * calculateCustomScore() below is a byte-for-byte copy of the function in
 * lib/intelligence/scoring.ts. The worker can't import that file directly
 * (it uses "@/utils/supabase/server", a Next.js-only, cookie-based client) —
 * so this copy exists on purpose. If you ever change the formula in
 * scoring.ts, update this function too.
 */

export const DEFAULT_WEIGHTS = {
  hiring_weight: 40,
  tech_stack_weight: 30,
  traffic_weight: 30,
  base_score: 0,
};

export function extractDomain(url = "") {
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  }
}

const SERPAPI_KEY = () => process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY;

export async function searchJobs(keyword, location) {
  const apiKey = SERPAPI_KEY();
  if (!apiKey) throw new Error("No SERPAPI_KEY found");

  const query = location ? `${keyword} ${location}` : keyword;
  const url = `https://serpapi.com/search.json?engine=google_jobs&q=${encodeURIComponent(query)}&api_key=${apiKey}&hl=en`;

  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(`SerpAPI error: ${json.error}`);
  return json.jobs_results || [];
}


export function groupByCompany(jobs) {
  const map = new Map();
  for (const job of jobs) {
    const company = job.company_name?.trim();
    if (!company) continue;

    if (!map.has(company)) {
      map.set(company, {
        company,
        domain: extractDomain(job.related_links?.[0]?.link || "") || null,
        jobPosts: 0,
        titles: [],
        locations: [],
        via: job.via || "",
      });
    }

    const entry = map.get(company);
    entry.jobPosts++;
    if (job.title) entry.titles.push(job.title);
    if (job.location) entry.locations.push(job.location);
  }
  return [...map.values()];
}

export function getStatus(score) {
  if (score >= 80) return "aggressive_hiring";
  if (score >= 65) return "active_hiring";
  if (score >= 50) return "warm";
  return "cold";
}

// Byte-for-byte copy of calculateCustomScore in lib/intelligence/scoring.ts —
// see the file header comment for why this isn't a shared import.
export function calculateCustomScore(signals, weights) {
  let score = weights.base_score;
  if (signals.is_hiring === true) score += weights.hiring_weight;
  if (signals.has_target_tech === true) score += weights.tech_stack_weight;
  if (signals.high_traffic === true) score += weights.traffic_weight;
  return Math.min(score, 100);
}

// Threshold for "high traffic" — company_insights.traffic_score is 0-100.
// No config for this yet; hardcoded here and in the company-insights rescore
// hook. If you want this configurable, it needs its own settings field.
export const HIGH_TRAFFIC_THRESHOLD = 60;

/**
 * Turns raw signal data into the boolean flags calculateCustomScore expects.
 * A company pulled from Google Jobs is, by definition, hiring — so
 * is_hiring is always true here. has_target_tech/high_traffic depend on
 * whether a company_insights row already exists for the domain; if not,
 * they default to false (NOT unknown — see note below).
 */
export function toScoringSignals({ techStack, trafficScore }) {
  return {
    is_hiring: true,
    has_target_tech: Array.isArray(techStack) && techStack.length > 0,
    high_traffic: typeof trafficScore === "number" && trafficScore >= HIGH_TRAFFIC_THRESHOLD,
  };
}

export async function fetchScoringWeights(supabase, orgId) {
  const { data } = await supabase
    .from("scoring_configs")
    .select("weights")
    .eq("org_id", orgId)
    .maybeSingle();
  return data?.weights || DEFAULT_WEIGHTS;
}

export async function fetchCompanyInsight(supabase, orgId, domain) {
  if (!domain) return null;
  const { data } = await supabase
    .from("company_insights")
    .select("tech_stack, traffic_score")
    .eq("org_id", orgId)
    .eq("domain", domain)
    .maybeSingle();
  return data || null;
}
