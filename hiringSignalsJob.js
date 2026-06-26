/**
 * CompX Worker — src/jobs/hiringSignalsJob.js (FIXED)
 *
 * Fixes applied:
 *   1. createLogger() — buffered logging, Supabase read+write per log বন্ধ
 *   2. Upsert with onConflict — duplicate signals বন্ধ
 *   3. Domain guess সরানো — unreliable ".com" fallback বন্ধ
 */

import { supabase } from "../config/supabase.js";
import { createLogger } from "../lib/terminalLogger.js";

const SERPAPI_KEY = () => process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY;

function calcHiringScore(jobPosts, keywords) {
  let score = 30;
  if      (jobPosts >= 10) score += 40;
  else if (jobPosts >= 5)  score += 30;
  else if (jobPosts >= 2)  score += 20;
  else                     score += 10;

  const highValue = ["head of","director","vp ","chief","lead ","senior","manager"];
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

function extractDomain(url = "") {
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  }
}

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

function groupByCompany(jobs) {
  const map = new Map();
  for (const job of jobs) {
    const company = job.company_name?.trim();
    if (!company) continue;

    if (!map.has(company)) {
      map.set(company, {
        company,
        domain:    extractDomain(job.related_links?.[0]?.link || "") || null,
        jobPosts:  0,
        titles:    [],
        locations: [],
        via:       job.via || "",
      });
    }

    const entry = map.get(company);
    entry.jobPosts++;
    if (job.title)    entry.titles.push(job.title);
    if (job.location) entry.locations.push(job.location);
  }
  return [...map.values()];
}

export async function runHiringSignals(inputData, userId, job) {
  const jobId = job?.id || "manual";
  const { keyword, location, orgId } = inputData;

  // FIX 1: createLogger — buffered, আর per-log Supabase call নয়
  const logger = createLogger(jobId);

  try {
    await logger.log(`Starting hiring signals: "${keyword}" in "${location || "global"}"`);
    if (!keyword) throw new Error("keyword is required");

    await logger.log("Searching Google Jobs via SerpAPI...");
    let jobs = [];

    try {
      jobs = await searchJobs(keyword, location);
      await logger.log(`Found ${jobs.length} job postings`);
    } catch (err) {
      await logger.log(`SerpAPI error: ${err.message}`);
      throw err;
    }

    if (jobs.length === 0) {
      await logger.log(`No jobs found for "${keyword}"`);
      return { count: 0, signals: [] };
    }

    const companies = groupByCompany(jobs);
    await logger.log(`Found ${companies.length} unique companies hiring`);

    const signals = companies.map(c => {
      const score  = calcHiringScore(c.jobPosts, c.titles);
      const status = getStatus(score);

      return {
        company: c.company,
        // FIX 3: domain guess সরানো — ভুল domain দিয়ে enrichment fail হত
        // আগে: domain না পেলে "companyname.com" বানাত — বেশিরভাগই invalid
        domain: c.domain || null,
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

    signals.sort((a, b) => b.score - a.score);

    await logger.log(`Saving ${signals.length} signals to database...`);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const toInsert = signals.map(s => ({
      org_id:     orgId,
      company:    s.company,
      domain:     s.domain,
      score:      s.score,
      status:     s.status,
      signals:    s.signals,
      source:     "google_jobs",
      dedup_key:  `${keyword}_${location || "global"}`,
      location:   location || null,
      expires_at: expiresAt.toISOString(),
      created_at: new Date().toISOString(),
    }));

    if (toInsert.length > 0) {
      // FIX 2: upsert — একই dedup_key+domain+org এ duplicate signal বন্ধ
      // DB তে unique constraint দরকার: UNIQUE (org_id, domain, dedup_key)
      const { error } = await supabase
        .from("intelligence_signals")
        .upsert(toInsert, {
          onConflict:       "org_id,domain,dedup_key",
          ignoreDuplicates: false, // update করুন — score পুরনো হলে নতুন নেবে
        });

      if (error) {
        await logger.log(`[ERROR] DB save failed: ${error.message}`);
        throw error;
      }
    }

    const hot = signals.filter(s => s.score >= 80);
    await logger.log(`Hot signals: ${hot.length} companies aggressively hiring`);
    for (const s of signals.slice(0, 5)) {
      await logger.log(`✓ ${s.company} — ${s.status} (score: ${s.score}, jobs: ${s.signals.job_posts})`);
    }
    await logger.log(`Done — ${signals.length} hiring signals saved`);

    return { count: signals.length, signals };

  } finally {
    // Job শেষে buffer flush করুন
    await logger.close();
  }
}
