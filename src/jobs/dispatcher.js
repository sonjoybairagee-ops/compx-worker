/**
 * CompX — dispatcher.js
 *
 * CHANGES (startup-optimized):
 *   1. DISABLED_JOBS check — hiring_signals, webhook, drip gracefully block করে
 *   2. deep_scrape → discover_scrape normalize (index.js এর সাথে মিল রাখা)
 *   3. runDiscoverScrape call এ job object যোগ — signature ঠিক করা
 *   4. auto_verify chain এখনো কাজ করে
 *   5. analyzeJobRisk import path ঠিক করা (routingEngine → scrapingBrain)
 */

import { supabase }          from "./config/supabase.js";
import { compxJobsQueue }    from "./config/queueRegistry.js";
import { runEnrichJob }      from "./jobs/enrichJob.js";
import { runDiscoverScrape } from "./jobs/discoverScrapeJob.js";
import { runVerifyEmail }    from "./jobs/verifyEmailJob.js";
import { runPipelineFilter } from "./jobs/pipelineFilterJob.js";
import { getBestProxy, markProxyFail, markProxySuccess } from "../../lib/proxy.js";
import { analyzeJobRisk }    from "../../lib/scrapingBrain.js"; // routingEngine → scrapingBrain

// ── Startup এ disabled jobs ───────────────────────────────────────────────────
// পরে চালু করতে হলে এই set থেকে বাদ দাও
const DISABLED_JOBS = new Set(["hiring_signals", "webhook", "drip"]);

// ── Platform scrape job names → discover_scrape normalize ────────────────────
const SCRAPE_JOB_NAMES = new Set([
  "deep_scrape",        // আগের নাম — এখন discover_scrape
  "discover_scrape",
  "google-maps-scrape",
  "linkedin-scrape",
  "instagram-biz-scrape",
  "youtube-scrape",
  "websites-scrape",
  "startup-db-scrape",
]);

function normalizeDomain(raw) {
  return raw.trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .toLowerCase();
}

function classifyJobType(input) {
  const { type, source, emails, domains, dbLeadId } = input;
  if (type === "pipeline_filter" || dbLeadId) return "pipeline_filter";
  if (type) return SCRAPE_JOB_NAMES.has(type) ? "discover_scrape" : type;
  if (emails?.length)  return "verify_email";
  if (source === "google_maps" || source === "yellow_pages") return "discover_scrape";
  if (domains?.length) return "enrich";
  throw new Error("Cannot classify job — provide type, emails, domains, or dbLeadId");
}

async function createJobRecord(userId, jobType, inputData, mode) {
  const { data, error } = await supabase
    .from("enrichment_jobs")
    .insert({
      user_id:    userId,
      type:       jobType,
      status:     mode === "realtime" ? "running" : "pending",
      input_data: inputData,
      progress:   0,
      created_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw new Error(`DB insert failed: ${error.message}`);
  return data;
}

export async function updateJobProgress(jobId, progress, found) {
  await supabase.from("enrichment_jobs").update({
    progress,
    result_summary: { leads_found: found },
    updated_at:     new Date().toISOString(),
  }).eq("id", jobId);
}

// ── Main dispatcher ───────────────────────────────────────────────────────────
export async function dispatchJob(userId, input, mode = "realtime") {
  const jobType = classifyJobType(input);

  // Disabled job check — graceful block
  if (DISABLED_JOBS.has(jobType)) {
    console.warn(`[Dispatcher] Job type "${jobType}" is disabled in startup mode`);
    return { jobId: null, status: "disabled", reason: `${jobType} not available yet` };
  }

  const job = await createJobRecord(userId, jobType, input, mode);

  if (mode === "queue") {
    const queue = compxJobsQueue();
    await queue.add(jobType, {
      supabase_id: job.id,
      id:          job.id,
      type:        jobType,
      user_id:     userId,
      input_data:  input,
    }, {
      jobId:    `sb_${job.id}`,
      attempts: 3,
      backoff:  { type: "exponential", delay: 5000 },
    });

    console.log(`[Dispatcher] Queued job ${job.id} (${jobType}) → BullMQ`);
    return { jobId: job.id, status: "queued" };
  }

  // Realtime — background এ চালাও, caller কে block করো না
  runJobWorker(job.id, userId, jobType, input).catch(err => {
    console.error(`[Dispatcher] Worker error for ${job.id}:`, err.message);
  });

  return { jobId: job.id, status: "running" };
}

// ── Realtime job runner ───────────────────────────────────────────────────────
async function runJobWorker(jobId, userId, jobType, input) {
  const routing = analyzeJobRisk({
    domain:  input.domain || input.website,
    source:  input.source,
    country: input.country,
    type:    jobType,
  });

  const proxy   = getBestProxy(routing);
  const started = Date.now();

  await sleep(routing.delayMs);

  try {
    await supabase.from("enrichment_jobs").update({
      status:   "running",
      proxy_id: proxy?.id ?? null,
    }).eq("id", jobId);

    let result;

    if (jobType === "enrich") {
      const domains = input.domains ?? [input.domain];
      result = await runEnrichPipeline(domains, userId, jobId, proxy?.url, routing);

    } else if (jobType === "discover_scrape") {
      // index.js এর মতো job object বানাও — runDiscoverScrape এ দরকার
      const fakeJob = {
        id: jobId,
        updateProgress: async (data) => {
          await supabase.from("enrichment_jobs").update({
            progress:       data.processedCount
              ? Math.round((data.processedCount / (data.totalCount || 1)) * 100)
              : 0,
            result_summary: data,
            updated_at:     new Date().toISOString(),
          }).eq("id", jobId);
        },
      };
      result = await runDiscoverScrape({ ...input, proxyUrl: proxy?.url }, userId, fakeJob, proxy);

    } else if (jobType === "verify_email") {
      result = await runVerifyEmail({ ...input }, userId);

    } else if (jobType === "pipeline_filter") {
      result = await runPipelineFilter({ ...input }, userId);

    } else {
      throw new Error(`Unknown job type: ${jobType}`);
    }

    if (result?.paused) return;

    const latency = Date.now() - started;
    if (proxy) await markProxySuccess(proxy.id, latency);

    await supabase.from("enrichment_jobs").update({
      status:         "completed",
      progress:       100,
      result_summary: result,
      completed_at:   new Date().toISOString(),
    }).eq("id", jobId);

    // Auto verify chain — email enrichment এর পরে verify করো
    if (input.auto_verify && result?.emails?.length) {
      await dispatchJob(userId, {
        type:   "verify_email",
        emails: result.emails,
        leadId: input.leadId,
      }, "queue");
    }

  } catch (err) {
    if (proxy) await markProxyFail(proxy.id);
    await supabase.from("enrichment_jobs").update({
      status:    "failed",
      error_msg: err.message,
    }).eq("id", jobId);
    throw err;
  }
}

// ── Enrich pipeline (multiple domains) ───────────────────────────────────────
async function runEnrichPipeline(domains, userId, jobId, proxyUrl, routing) {
  const results = [];

  for (let i = 0; i < domains.length; i++) {
    // Pause check — user job pause করলে থামো
    const { data: jobState } = await supabase
      .from("enrichment_jobs")
      .select("status")
      .eq("id", jobId)
      .single();

    if (jobState?.status === "paused") {
      await updateJobProgress(jobId, Math.round((i / domains.length) * 100), results.length);
      return { paused: true, domains_processed: i, leads_found: results.length };
    }

    const domain       = normalizeDomain(domains[i]);
    const domainRouting = analyzeJobRisk({ domain });
    await sleep(Math.max(routing?.delayMs ?? 800, domainRouting.delayMs));

    const r = await runEnrichJob({ website: domain, domain, proxyUrl }, userId);
    if (r) results.push(r);

    await updateJobProgress(
      jobId,
      Math.round(((i + 1) / domains.length) * 100),
      results.length
    );
  }

  return {
    domains_processed: domains.length,
    leads_found:       results.length,
    emails:            results.flatMap(r => r.emails ?? []),
    phones:            results.flatMap(r => r.phones ?? []),
    hunterUsed:        results.filter(r => r.hunterUsed).length,
    patternPredicted:  results.filter(r => r.patternPredicted).length,
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }