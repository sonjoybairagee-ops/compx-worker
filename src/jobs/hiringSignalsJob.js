/**
 * CompX Worker — src/jobs/hiringSignalsJob.js
 * SerpAPI Google Jobs দিয়ে hiring signals detect করে
 * intelligence_signals table-এ save করে → Frontend realtime দেখায়
 */

import { supabase } from "../config/supabase.js";

const SERPAPI_KEY = () => process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY;

// ── Logger ────────────────────────────────────────────────────────────────────
async function log(jobId, message) {
  console.log(`[HiringSignals ${jobId}] ${message}`);
  try {
    const { data } = await supabase.from("jobs").select("terminal_logs").eq("id", jobId).single();
    const logs = data?.terminal_logs || [];
    logs.push({ time: new Date().toISOString(), message });
    await supabase.from("jobs").update({ terminal_logs: logs }).eq("id", jobId);
  } catch {}
}

// ── Score calculation ─────────────────────────────────────────────────────────
function calcHiringScore(jobPosts, keywords) {
  let score = 30;
  if (jobPosts >= 10) score += 40;       // Aggressive hiring
  else if (jobPosts >= 5) score += 30;   // Active hiring
  else if (jobPosts >= 2) score += 20;   // Warm
  else score += 10;                       // Cold

  // High-value keywords
  const highValue = ["head of", "director", "vp ", "chief", "lead ", "senior", "manager"];
  const matched = keywords.filter(k => highValue.some(h => k.toLowerCase().includes(h)));
  score += matched.length * 5;

  return Math.min(99, score);
}

function getStatus(score) {
  if (score >= 80) return "aggressive_hiring";
  if (score >= 65) return "active_hiring";
  if (score >= 50) return "warm";
  return "cold";
}

// ── Extract company domain from URL ──────────────────────────────────────────
function extractDomain(url = "") {
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  }
}

// ── SerpAPI Google Jobs Search ────────────────────────────────────────────────
async function searchJobs(keyword, location) {
  const apiKey = SERPAPI_KEY();
  if (!apiKey) throw new Error("No SERPAPI_KEY found");

  const query = location ? `${keyword} ${location}` : keyword;
  const url = `https://serpapi.com/search.json?engine=google_jobs&q=${encodeURIComponent(query)}&api_key=${apiKey}&hl=en`;

  const res  = await fetch(url);
  const json = await res.json();

  if (json.error) throw new Error(`SerpAPI error: ${json.error}`);

  return json.jobs_results || [];
}

// ── Group jobs by company ─────────────────────────────────────────────────────
function groupByCompany(jobs) {
  const map = new Map();

  for (const job of jobs) {
    const company = job.company_name?.trim();
    if (!company) continue;

    if (!map.has(company)) {
      map.set(company, {
        company,
        domain:    extractDomain(job.related_links?.[0]?.link || ""),
        jobPosts:  0,
        titles:    [],
        locations: [],
        via:       job.via || "",
      });
    }

    const entry = map.get(company);
    entry.jobPosts++;
    if (job.title) entry.titles.push(job.title);
    if (job.location) entry.locations.push(job.location);
  }

  return [...map.values()];
}

// ── Main Job ──────────────────────────────────────────────────────────────────
export async function runHiringSignals(inputData, userId, job) {
  const jobId  = job?.id || "manual";
  const { keyword, location, orgId } = inputData;

  await log(jobId, `Starting hiring signals: "${keyword}" in "${location || "global"}"`);

  if (!keyword) throw new Error("keyword is required");

  // ── Step 1: Search jobs ───────────────────────────────────────────────────
  await log(jobId, `Searching Google Jobs via SerpAPI...`);
  let jobs = [];

  try {
    jobs = await searchJobs(keyword, location);
    await log(jobId, `Found ${jobs.length} job postings`);
  } catch (err) {
    await log(jobId, `SerpAPI error: ${err.message}`);
    throw err;
  }

  if (jobs.length === 0) {
    await log(jobId, `No jobs found for "${keyword}"`);
    return { count: 0, signals: [] };
  }

  // ── Step 2: Group by company ──────────────────────────────────────────────
  const companies = groupByCompany(jobs);
  await log(jobId, `Found ${companies.length} unique companies hiring`);

  // ── Step 3: Score + classify ──────────────────────────────────────────────
  const signals = companies.map(c => {
    const score  = calcHiringScore(c.jobPosts, c.titles);
    const status = getStatus(score);

    return {
      company:  c.company,
      domain:   c.domain || c.company.toLowerCase().replace(/\s+/g, "") + ".com",
      score,
      status,
      signals: {
        hiring:    true,
        growth:    score >= 65,
        job_posts: c.jobPosts,
        keywords:  [...new Set(c.titles)].slice(0, 5),
        locations: [...new Set(c.locations)].slice(0, 3),
      },
    };
  });

  // Sort by score descending
  signals.sort((a, b) => b.score - a.score);

  // ── Step 4: Save to intelligence_signals ──────────────────────────────────
  await log(jobId, `Saving ${signals.length} signals to database...`);

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7); // 7 days TTL

  const toInsert = signals.map(s => ({
    org_id:     orgId,
    company:    s.company,
    domain:     s.domain,
    score:      s.score,
    status:     s.status,
    signals:    s.signals,
    source:     "google_jobs",
    keyword,
    location:   location || null,
    expires_at: expiresAt.toISOString(),
    created_at: new Date().toISOString(),
  }));

  if (toInsert.length > 0) {
    const { error } = await supabase
      .from("intelligence_signals")
      .insert(toInsert);

    if (error) {
      await log(jobId, `[ERROR] DB save failed: ${error.message}`);
      throw error;
    }
  }

  // Log top signals
  const hot = signals.filter(s => s.score >= 80);
  await log(jobId, `🔥 Hot signals: ${hot.length} companies aggressively hiring`);
  for (const s of signals.slice(0, 5)) {
    await log(jobId, `✓ ${s.company} — ${s.status} (score: ${s.score}, jobs: ${s.signals.job_posts})`);
  }

  await log(jobId, `✅ Done — ${signals.length} hiring signals saved`);

  return { count: signals.length, signals };
}
