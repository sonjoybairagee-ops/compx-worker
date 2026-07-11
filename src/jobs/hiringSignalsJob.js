/**
 * CompX Worker — src/jobs/hiringSignalsJob.js
 *
 * Round 3 change: scoring now matches lib/intelligence/scoring.ts's real
 * boolean-flag formula (is_hiring / has_target_tech / high_traffic), not
 * round 2's continuous weighted-average model. See scoringMath.js header
 * comment for why the worker keeps its own copy of the formula.
 */

import { supabase } from "../config/supabase.js";
import { createLogger } from "../lib/terminalLogger.js";
import {
  groupByCompany,
  searchJobs,
  getStatus,
  calculateCustomScore,
  toScoringSignals,
  fetchScoringWeights,
  fetchCompanyInsight,
} from "../lib/intelligence/scoringMath.js";

export async function runHiringSignals(inputData, userId, job) {
  const jobId = job?.id || "manual";
  const { keyword, location, orgId } = inputData;

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

    const weights = await fetchScoringWeights(supabase, orgId);

    const signals = [];
    for (const c of companies) {
      const insight = await fetchCompanyInsight(supabase, orgId, c.domain);
      const enrichmentPending = !insight; // no company_insights row yet for this domain

      const scoringSignals = toScoringSignals({
        techStack: insight?.tech_stack ?? null,
        trafficScore: insight?.traffic_score ?? null,
      });
      const score = calculateCustomScore(scoringSignals, weights);

      signals.push({
        company: c.company,
        domain: c.domain || null,
        score,
        status: getStatus(score),
        signals: {
          hiring: true,
          growth: score >= 65,
          job_posts: c.jobPosts,
          keywords: [...new Set(c.titles)].slice(0, 5),
          locations: [...new Set(c.locations)].slice(0, 3),
          scoring_signals: scoringSignals,
          enrichment_pending: enrichmentPending,
        },
      });
    }

    signals.sort((a, b) => b.score - a.score);

    await logger.log(`Saving ${signals.length} signals to database...`);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const toInsert = signals.map(s => ({
      org_id: orgId,
      company: s.company,
      domain: s.domain,
      score: s.score,
      status: s.status,
      signals: s.signals,
      source: "google_jobs",
      dedup_key: `${keyword}_${location || "global"}`,
      location: location || null,
      expires_at: expiresAt.toISOString(),
      created_at: new Date().toISOString(),
    }));

    if (toInsert.length > 0) {
      const { error } = await supabase
        .from("intelligence_signals")
        .upsert(toInsert, {
          onConflict: "org_id,domain,dedup_key",
          ignoreDuplicates: false,
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
    await logger.close();
  }
}
