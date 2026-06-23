/**
 * dispatcher.js (FIXED)
 *
 * Fixes applied:
 *   1. BullMQ properly wired — queue mode এ job হারায় না
 *   2. supabase_id job data এ পাঠানো হচ্ছে
 */

import { supabase }    from "./config/supabase.js";
import { compxJobsQueue } from "./config/queueRegistry.js"; // FIX 1: registry থেকে import
import { runEnrichJob }      from "./jobs/enrichJob.js";
import { runDiscoverScrape } from "./jobs/discoverScrapeJob.js";
import { runVerifyEmail }    from "./jobs/verifyEmailJob.js";
import { runPipelineFilter } from "./jobs/pipelineFilterJob.js";
import { getBestProxy, markProxyFail, markProxySuccess } from "../../lib/proxy.js";
import { analyzeJobRisk } from "../../lib/routingEngine.js";

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
  if (type) return type;
  if (emails?.length) return "verify_email";
  if (source === "google_maps" || source === "yellow_pages") return "deep_scrape";
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
    updated_at: new Date().toISOString(),
  }).eq("id", jobId);
}

export async function dispatchJob(userId, input, mode = "realtime") {
  const jobType = classifyJobType(input);
  const job     = await createJobRecord(userId, jobType, input, mode);

  if (mode === "queue") {
    // FIX 1: BullMQ তে actually add করুন — আগে শুধু log করে return করত
    // FIX 2: supabase_id পাঠানো হচ্ছে — processJob সঠিক row update করবে
    const queue = compxJobsQueue();
    await queue.add(jobType, {
      supabase_id: job.id,   // Supabase UUID
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

  // Realtime — তাৎক্ষণিক চালানো
  runJobWorker(job.id, userId, jobType, input).catch(err => {
    console.error(`[Dispatcher] Worker error for ${job.id}:`, err.message);
  });

  return { jobId: job.id, status: "running" };
}

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
      status: "running", proxy_id: proxy?.id ?? null,
    }).eq("id", jobId);

    let result;

    if (jobType === "enrich") {
      const domains = input.domains ?? [input.domain];
      result = await runEnrichPipeline(domains, userId, jobId, proxy?.url, routing);
    } else if (jobType === "deep_scrape") {
      result = await runDiscoverScrape({ ...input, proxyUrl: proxy?.url }, userId);
    } else if (jobType === "verify_email") {
      result = await runVerifyEmail({ ...input }, userId);
    } else if (jobType === "pipeline_filter") {
      result = await runPipelineFilter({ ...input }, userId);
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

    if (input.auto_verify && result?.emails?.length) {
      await dispatchJob(userId, {
        type: "verify_email", emails: result.emails, leadId: input.leadId,
      }, "queue");
    }

  } catch (err) {
    if (proxy) await markProxyFail(proxy.id);
    await supabase.from("enrichment_jobs").update({
      status: "failed", error_msg: err.message,
    }).eq("id", jobId);
    throw err;
  }
}

async function runEnrichPipeline(domains, userId, jobId, proxyUrl, routing) {
  const results = [];
  for (let i = 0; i < domains.length; i++) {
    const { data: jobState } = await supabase
      .from("enrichment_jobs").select("status").eq("id", jobId).single();
    if (jobState?.status === "paused") {
      await updateJobProgress(jobId, Math.round((i / domains.length) * 100), results.length);
      return { paused: true, domains_processed: i, leads_found: results.length };
    }

    const domain = normalizeDomain(domains[i]);
    const domainRouting = analyzeJobRisk({ domain });
    await sleep(Math.max(routing?.delayMs ?? 800, domainRouting.delayMs));

    const r = await runEnrichJob({ website: domain, domain, proxyUrl }, userId);
    if (r) results.push(r);
    await updateJobProgress(jobId, Math.round(((i + 1) / domains.length) * 100), results.length);
  }
  return {
    domains_processed: domains.length,
    leads_found:  results.length,
    emails: results.flatMap(r => r.emails ?? []),
    phones: results.flatMap(r => r.phones ?? []),
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
