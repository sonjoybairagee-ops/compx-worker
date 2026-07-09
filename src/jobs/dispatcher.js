/**
 * worker/src/jobs/dispatcher.js
 *
 * Rebuilt after the worker/ folder deletion. Registry-only for
 * discover_scrape — the old discoverScrapeJob.js monolith is gone, so there
 * is no legacy fallback anymore. All 8 platforms (website, google_maps,
 * instagram, linkedin, youtube, amazon, facebook, ebay, tripadvisor) are
 * registered in @compx/worker-registry, so this should never hit the
 * "no plugin" branch in normal operation — it exists only to fail loudly
 * and clearly instead of crashing if a source is ever requested that
 * isn't registered.
 *
 * FIX: SCRAPE_JOB_NAMES and DISCOVER_SOURCES below were never updated
 * when the eBay and Tripadvisor plugins were added (platforms.ts and
 * plugins/ebay|tripadvisor/index.ts already existed, but this file still
 * only listed the original 6). In the normal path this is harmless — the
 * job's `type` is always explicitly "discover_scrape" from /api/scrape,
 * so classifyJobType() returns early and never consults these sets. But
 * anything that classifies a job by `source` alone (no explicit `type`),
 * or that uses a platform's `jobName` value ("ebay-scrape",
 * "tripadvisor-scrape" from platforms.ts) as the job type, would silently
 * misclassify or throw "Unknown job type" for these two platforms only.
 * Added them for consistency with the other 6.
 *
 * UPDATED: removed the post-completion lump-sum credit deduction
 * (calculateCreditCost / CREDIT_WEIGHTS) that used to run here. It was
 * broken (2-arg `deduct_credits` call, missing `p_user_id`) and, even once
 * fixed, would have double-charged on top of the per-lead charging that
 * now happens INSIDE each plugin via `chargeForLead()` (see
 * scraper-core/credits.ts and each plugins/*/index.ts). Credits are spent
 * as leads are found, not once in bulk after the job finishes.
 */

import { supabase } from "../config/supabase.js";
import { compxJobsQueue } from "../config/queueRegistry.js";
import { runEnrichJob } from "./enrichJob.js";
import { runVerifyEmail } from "./verifyEmailJob.js";
import { runPipelineFilter } from "./pipelineFilterJob.js";
import { getPlugin } from "@compx/worker-registry";
import { getProxyManager, analyzeJobRisk } from "@compx/scraper-core";
import { ENRICHMENT_COSTS } from "@compx/scraper-core";

const DISABLED_JOBS = new Set(["hiring_signals", "webhook", "drip"]);

const SCRAPE_JOB_NAMES = new Set([
  "deep_scrape", "discover_scrape", "google-maps-scrape", "linkedin-scrape",
  "instagram-biz-scrape", "youtube-scrape", "websites-scrape",
  "startup-db-scrape", "amazon-scrape", "facebook-scrape",
  "ebay-scrape", "tripadvisor-scrape",
]);

const DISCOVER_SOURCES = new Set([
  "google_maps", "youtube", "instagram_biz", "linkedin", "website", "amazon", "facebook",
  "ebay", "tripadvisor",
]);

function normalizeDomain(raw) {
  return raw.trim().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase();
}

function classifyJobType(input) {
  const { type, source, emails, domains, dbLeadId } = input;
  if (type === "pipeline_filter" || dbLeadId) return "pipeline_filter";
  if (type) return SCRAPE_JOB_NAMES.has(type) ? "discover_scrape" : type;
  if (emails?.length) return "verify_email";
  if (DISCOVER_SOURCES.has(source)) return "discover_scrape";
  if (domains?.length) return "enrich";
  throw new Error("Cannot classify job — provide type, emails, domains, or dbLeadId");
}

async function createJobRecord(userId, jobType, inputData, mode) {
  const { data, error } = await supabase
    .from("enrichment_jobs")
    .insert({
      user_id: userId, type: jobType,
      status: mode === "realtime" ? "running" : "pending",
      input_data: inputData, progress: 0,
      created_at: new Date().toISOString(),
    })
    .select().single();
  if (error) throw new Error(`DB insert failed: ${error.message}`);
  return data;
}

export async function updateJobProgress(jobId, progress, found) {
  await supabase.from("enrichment_jobs").update({
    progress, result_summary: { leads_found: found }, updated_at: new Date().toISOString(),
  }).eq("id", jobId);
}

// Phase 16 hook — feeds workers/scheduler's popular-search pre-scrape.
async function logSearch(input) {
  if (!input?.source) return;
  try {
    await supabase.from("search_log").insert({
      source: input.source, keyword: input.keyword || null, location: input.location || null,
    });
  } catch (err) {
    console.warn("[Dispatcher] search_log insert failed (non-fatal):", err.message);
  }
}

export async function dispatchJob(userId, input, mode = "realtime") {
  const jobType = classifyJobType(input);

  if (DISABLED_JOBS.has(jobType)) {
    console.warn(`[Dispatcher] Job type "${jobType}" is disabled`);
    return { jobId: null, status: "disabled", reason: `${jobType} not available yet` };
  }

  if (jobType === "discover_scrape") await logSearch(input);

  const job = await createJobRecord(userId, jobType, input, mode);

  if (mode === "queue") {
    const queue = compxJobsQueue();
    await queue.add(jobType, {
      supabase_id: job.id, id: job.id, type: jobType, user_id: userId, input_data: input,
    }, {
      jobId: `sb_${job.id}`, attempts: 3, backoff: { type: "exponential", delay: 5000 },
    });
    console.log(`[Dispatcher] Queued job ${job.id} (${jobType}) → BullMQ`);
    return { jobId: job.id, status: "queued" };
  }

  runJobWorker(job.id, userId, jobType, input).catch(async (err) => {
    console.error(`[Dispatcher] Worker error for ${job.id}:`, err.message);
    await supabase.from("enrichment_jobs").update({
      status: "failed", error_msg: err.message, updated_at: new Date().toISOString(),
    }).eq("id", job.id);
  });

  return { jobId: job.id, status: "running" };
}

async function runJobWorker(jobId, userId, jobType, input) {
  const routing = analyzeJobRisk({
    domain: input.domain || input.website, source: input.source,
    country: input.country, type: jobType,
  });

  const proxy = await getProxyManager().getBest(routing);
  const started = Date.now();
  await sleep(routing.delayMs);

  try {
    await supabase.from("enrichment_jobs").update({
      status: "running", proxy_id: proxy?.id ?? null,
    }).eq("id", jobId);

    let result;

    if (jobType === "enrich") {
      const domains = input.domains ?? [input.domain];
      result = await runEnrichPipeline(domains, userId, jobId, routing, input.orgId);

    } else if (jobType === "discover_scrape") {
      const plugin = getPlugin(input.source);
      if (!plugin) {
        throw new Error(
          `No plugin registered for source "${input.source}". ` +
          `Registered: website, google_maps, instagram_biz, linkedin, youtube, amazon, facebook, ebay, tripadvisor.`
        );
      }
      // Credit charging + plan gating now happen INSIDE plugin.run() itself
      // (checkSourceAccess + chargeForLead, per lead) — nothing to do here.
      result = await plugin.run({
        userId,
        orgId: input.orgId ?? null,
        jobId,
        input,
        updateProgress: (data) => updateJobProgress(
          jobId,
          data.processedCount ? Math.round((data.processedCount / (data.totalCount || 1)) * 100) : 0,
          data.leads_found ?? data.saved ?? 0
        ),
      });

    } else if (jobType === "verify_email") {
      result = await runVerifyEmail({ ...input }, userId);

    } else if (jobType === "pipeline_filter") {
      result = await runPipelineFilter({ ...input }, userId);

    } else {
      throw new Error(`Unknown job type: ${jobType}`);
    }

    if (result?.paused) return;

    const latency = Date.now() - started;
    if (proxy) await getProxyManager().markSuccess(proxy.id, latency);

    await supabase.from("enrichment_jobs").update({
      status: "completed", progress: 100, result_summary: result, completed_at: new Date().toISOString(),
    }).eq("id", jobId);

    if (input.auto_verify && result?.emails?.length) {
      await dispatchJob(userId, {
        type:   "verify_email",
        emails: result.emails,
        leadId: input.leadId,
        orgId:  input.orgId || null,
      }, "queue");
    }

  } catch (err) {
    if (proxy) await getProxyManager().markFail(proxy.id);
    throw err;
  }
}

// FIX: this loop called runEnrichJob() directly with zero credit deduction
// AND with no error handling — a single domain throwing would crash the
// entire batch (see try/catch added below). Billing policy (confirmed):
// attempt-based — charge once a lookup actually completes, whether or not
// it found an email (Hunter/Serper/proxy cost is spent either way). Only
// a genuine system failure (thrown exception) is free, since nothing
// completed. This job type has no retry loop (each domain runs once), so
// there's no risk of double-charging across attempts the way there is in
// pipelineFilterJob.js.
async function chargeEnrichAttempt(userId, orgId) {
  const amount = ENRICHMENT_COSTS.website_enrichment;
  try {
    await supabase.rpc("deduct_credits", {
      p_user_id: userId,
      p_org_id:  orgId || userId,
      p_amount:  amount,
    });
  } catch (err) {
    console.error("[Dispatcher] Credit deduct error:", err.message);
  }
}

async function runEnrichPipeline(domains, userId, jobId, routing, orgId) {
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

    try {
      const r = await runEnrichJob({ website: domain, domain }, userId);
      if (r) results.push(r);
      await chargeEnrichAttempt(userId, orgId); // completed — charge whether or not an email was found
    } catch (err) {
      console.error(`[Dispatcher] runEnrichJob failed for ${domain} (not charged):`, err.message);
    }

    await updateJobProgress(jobId, Math.round(((i + 1) / domains.length) * 100), results.length);
  }

  return {
    domains_processed: domains.length, leads_found: results.length,
    emails: results.flatMap(r => r.emails ?? []),
    phones: results.flatMap(r => r.phones ?? []),
    hunterUsed: results.filter(r => r.hunterUsed).length,
    patternPredicted: results.filter(r => r.patternPredicted).length,
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
