/**
 * CompX Worker — src/jobs/runSavedSearchesJob.js
 *
 * Scheduled monitoring for saved searches. Triggered by a periodic tick
 * (see app/api/cron/saved-searches-tick/route.ts for the trigger endpoint —
 * point Vercel Cron or any external scheduler at it).
 *
 * For each active saved search that's due (based on its frequency and
 * last_run_at):
 *   1. Re-run the same Google Jobs search
 *   2. Score + upsert signals exactly like a manual search (so the signal
 *      feed and "My Signals" stay in sync regardless of source)
 *   3. Diff against companies already seen for this exact (keyword, location)
 *      pair — only genuinely NEW companies generate an alert. Score updates
 *      on already-known companies still get saved, just silently.
 *   4. Write a dashboard alert row per new company, and optionally email.
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
import { sendAlertEmail } from "../lib/intelligence/sendAlertEmail.js";

const INTERVALS_MS = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

function isDue(search, now) {
  if (!search.last_run_at) return true;
  const last = new Date(search.last_run_at).getTime();
  const interval = INTERVALS_MS[search.frequency] || INTERVALS_MS.daily;
  return now - last >= interval;
}

async function getRecipientEmail(userId) {
  try {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error) return null;
    return data?.user?.email || null;
  } catch {
    return null;
  }
}

async function runOneSavedSearch(search, logger) {
  const { org_id: orgId, keyword, location, id: searchId, created_by } = search;
  const dedupKey = `${keyword}_${location || "global"}`;

  await logger.log(`Running saved search "${keyword}" (${location || "global"}) — org ${orgId}`);

  // Snapshot domains already on record for this exact search BEFORE this run,
  // so we can tell "new" from "still hiring."
  const { data: priorRows } = await supabase
    .from("intelligence_signals")
    .select("domain")
    .eq("org_id", orgId)
    .eq("dedup_key", dedupKey);
  const priorDomains = new Set((priorRows || []).map(r => r.domain).filter(Boolean));

  let jobs = [];
  try {
    jobs = await searchJobs(keyword, location);
  } catch (err) {
    await logger.log(`[ERROR] SerpAPI failed for saved search ${searchId}: ${err.message}`);
    return;
  }

  if (jobs.length === 0) {
    await supabase.from("saved_searches").update({ last_run_at: new Date().toISOString() }).eq("id", searchId);
    await logger.log(`No jobs found this run for "${keyword}"`);
    return;
  }

  const companies = groupByCompany(jobs);
  const weights = await fetchScoringWeights(supabase, orgId);

  const scored = [];
  for (const c of companies) {
    const insight = await fetchCompanyInsight(supabase, orgId, c.domain);
    const enrichmentPending = !insight;
    const scoringSignals = toScoringSignals({
      techStack: insight?.tech_stack ?? null,
      trafficScore: insight?.traffic_score ?? null,
    });
    const score = calculateCustomScore(scoringSignals, weights);
    scored.push({ ...c, score, status: getStatus(score), scoringSignals, enrichmentPending });
  }

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  const toInsert = scored.map(s => ({
    org_id: orgId,
    company: s.company,
    domain: s.domain,
    score: s.score,
    status: s.status,
    signals: {
      hiring: true,
      growth: s.score >= 65,
      job_posts: s.jobPosts,
      keywords: [...new Set(s.titles)].slice(0, 5),
      locations: [...new Set(s.locations)].slice(0, 3),
      scoring_signals: s.scoringSignals,
      enrichment_pending: s.enrichmentPending,
    },
    source: "google_jobs",
    dedup_key: dedupKey,
    location: location || null,
    expires_at: expiresAt.toISOString(),
    created_at: new Date().toISOString(),
  }));

  const { error: upsertError } = await supabase
    .from("intelligence_signals")
    .upsert(toInsert, { onConflict: "org_id,domain,dedup_key", ignoreDuplicates: false });

  if (upsertError) {
    await logger.log(`[ERROR] Upsert failed for saved search ${searchId}: ${upsertError.message}`);
    return;
  }

  const newSignals = scored.filter(s => s.domain && !priorDomains.has(s.domain));
  await logger.log(`${newSignals.length} new compan${newSignals.length === 1 ? "y" : "ies"} since last run`);

  if (newSignals.length > 0) {
    const alertRows = newSignals.map(s => ({
      org_id: orgId,
      saved_search_id: searchId,
      company: s.company,
      domain: s.domain,
      score: s.score,
      status: s.status,
      message: `${s.company} started hiring for "${keyword}" (${s.jobPosts} open role${s.jobPosts === 1 ? "" : "s"}) — score ${s.score}`,
    }));

    const { error: alertError } = await supabase.from("alerts").insert(alertRows);
    if (alertError) await logger.log(`[WARN] Failed to write dashboard alerts: ${alertError.message}`);

    if (search.notify_email) {
      const recipient = await getRecipientEmail(created_by);
      try {
        await sendAlertEmail(recipient, search, newSignals);
      } catch (err) {
        await logger.log(`[WARN] Alert email failed: ${err.message}`);
      }
    }
  }

  await supabase.from("saved_searches").update({ last_run_at: new Date().toISOString() }).eq("id", searchId);
}

export async function runSavedSearchesTick() {
  const logger = createLogger("saved-searches-tick");
  try {
    const { data: activeSearches, error } = await supabase
      .from("saved_searches")
      .select("*")
      .eq("is_active", true);

    if (error) throw error;

    const now = Date.now();
    const due = (activeSearches || []).filter(s => isDue(s, now));
    await logger.log(`${due.length} of ${activeSearches?.length || 0} active saved searches are due`);

    for (const search of due) {
      await runOneSavedSearch(search, logger);
    }

    return { checked: activeSearches?.length || 0, run: due.length };
  } finally {
    await logger.close();
  }
}
