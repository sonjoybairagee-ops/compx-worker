// worker/src/index.js
import "dotenv/config";
import { Worker, DelayedError } from "bullmq";
import IORedis from "ioredis";
import { runEnrichJob } from "./jobs/enrichJob.js";
import { runVerifyEmail } from "./jobs/verifyEmailJob.js";
import { runPipelineFilter } from "./jobs/pipelineFilterJob.js";
import { pollSupabaseJobs } from "./poller.js";
import express from "express";
import { createBullBoardRouter } from "./config/bullBoard.js";
import { attachDLQListener } from "./config/dlqHandler.js";
import { Server } from "socket.io";
import http from "http";
import { supabase } from "./config/supabase.js";
// FIX (Redis limit exhaustion): jobQueue and leadEnrichmentQueue used to be
// created here with `new Queue(...)` directly, with NO defaultJobOptions —
// meaning no removeOnComplete/removeOnFail. Since poller.js, scheduler.ts,
// and the discover_scrape plugin's dispatchEnrichment() all add jobs to
// THESE exact instances (not the ones in queueRegistry.js), every job
// (including every single lead-enrichment sub-job) accumulated in Redis
// forever. This was the actual cause of exhausting the Redis command/
// memory quota. Now both queues are pulled from queueRegistry.js, which
// has removeOnComplete/removeOnFail cleanup configured — single source of
// truth for all producers (dispatcher.js, poller.js, scheduler.ts, and
// this file).
import { compxJobsQueue, leadEnrichmentQueue as getLeadEnrichmentQueue } from "./config/queueRegistry.js";

import { getPlugin } from "@compx/worker-registry";
import { runAiEnrichment } from "@compx/worker-ai-enrichment";
import { startScheduler } from "@compx/worker-scheduler";
import { getBrowserPool, getProxyManager, analyzeJobRisk, ENRICHMENT_COSTS } from "@compx/scraper-core";

const DISABLED_JOBS = new Set(["hiring_signals", "webhook", "drip"]);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function chargeEnrichAttempt(userId, orgId, amount = ENRICHMENT_COSTS.website_enrichment) {
  try {
    await supabase.rpc("deduct_credits", {
      p_user_id: userId,
      p_org_id: orgId || userId,
      p_amount: amount,
    });
  } catch (err) {
    console.error("[Worker] Credit deduct error (enrich):", err.message);
  }
}

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || "3");
const WORKER_PORT = parseInt(process.env.WORKER_PORT || process.env.PORT || "3001");

const redis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null, enableReadyCheck: false,
  tls: REDIS_URL.startsWith("rediss://") ? { rejectUnauthorized: false } : undefined,
  retryStrategy: (times) => Math.min(times * 500, 5000), // Keep trying forever
});

redis.on("connect", () => console.log("[Worker] Redis connected"));
redis.on("error", e => console.error("[Worker] Redis error:", e.message));

// FIX: pulled from queueRegistry.js instead of `new Queue(...)` here —
// see import comment above.
export const jobQueue = compxJobsQueue();
export const leadEnrichmentQueue = getLeadEnrichmentQueue();

const SCRAPE_JOB_NAMES = new Set([
  "discover_scrape", "google-maps-scrape", "linkedin-scrape",
  "instagram-biz-scrape", "youtube-scrape", "websites-scrape",
  "startup-db-scrape", "amazon-scrape", "facebook-scrape", "ebay-scrape", "tripadvisor-scrape",
]);

async function processJob(job) {
  const { input_data, user_id, billing_user_id } = job.data;
  const billingUserId = billing_user_id || user_id;
  let type = job.data.type || job.name;

  if (SCRAPE_JOB_NAMES.has(type)) type = "discover_scrape";

  if (DISABLED_JOBS.has(type)) {
    console.warn(`[Worker] Job type "${type}" is disabled — skipping`);
    await supabase.from("jobs").update({
      status: "failed", error: `Job type "${type}" is not available yet.`,
    }).eq("id", job.id);
    return { skipped: true, reason: "disabled" };
  }

  const routingCtx = { domain: input_data?.website || input_data?.domain, country: input_data?.country, type };
  const routing = analyzeJobRisk(routingCtx);
  const proxy = await getProxyManager().getBest(routing);

  console.log(`[Worker] Job ${job.id} (${type}) → risk:${routing.riskLevel} proxy:${proxy?.id || "none"}`);
  await sleep(routing.delayMs);

  await supabase.from("jobs").update({ status: "running", started_at: new Date().toISOString() }).eq("id", job.id);

  const startTime = Date.now();
  let result = null;

  try {
    switch (type) {
      case "enrich":
        result = await runEnrichJob(input_data, user_id);
        if (!result?.error) {
          await chargeEnrichAttempt(billingUserId, input_data?.orgId);
        }
        break;

      case "discover_scrape": {
        const plugin = getPlugin(input_data?.source);
        if (!plugin) {
          throw new Error(
            `No plugin registered for source "${input_data?.source}". ` +
            `Registered: website, google_maps, instagram, linkedin, youtube, amazon, facebook.`
          );
        }
        result = await plugin.run({
          userId: billingUserId,
          orgId: input_data?.orgId ?? null,
          jobId: job.id,
          input: input_data,
          redis,
          updateProgress: (data) => job.updateProgress(data),
          dispatchEnrichment: async (kind, payload) => {
            const dedupId = payload.domain || payload.leadId;
            if (!dedupId) return;

            const key = `enrich_lock:${kind}:${dedupId}`;
            const locked = await redis.set(key, "1", "EX", 300, "NX");
            if (locked === "OK") {
              await leadEnrichmentQueue.add("lead_enrichment", {
                type: "lead_enrichment",
                kind,
                user_id: billingUserId,
                orgId: input_data?.orgId ?? null,
                input_data: { ...payload, parentJobId: job.id, options: input_data.enrichments }
              });
              console.log(`[Worker] Queued ${kind} enrichment for ${dedupId}`);
            } else {
              console.log(`[Worker] Skipped ${kind} enrichment for ${dedupId} (already queued)`);
            }
          }
        });
        break;
      }

      case "verify_email":
        result = await runVerifyEmail(input_data, user_id);
        break;

      case "pipeline_filter":
        result = await runPipelineFilter(input_data, billingUserId);
        break;

      default:
        throw new Error(`Unknown job type: ${type}`);
    }

    if (proxy) await getProxyManager().markSuccess(proxy.id, Date.now() - startTime);

  } catch (err) {
    if (proxy) await getProxyManager().markFail(proxy.id);
    if (err.type === "CIRCUIT_OPEN") {
      const jitter = Math.floor(Math.random() * 60000); // 0-60s
      const delayMs = (10 * 60 * 1000) + jitter;
      console.warn(`[Worker] Circuit Open for job ${job.id}, delaying by ${delayMs}ms`);

      try {
        await job.moveToDelayed(Date.now() + delayMs, job.token);
      } catch (e) {
        // Fallback for bullmq
      }
      throw new DelayedError();
    }
    throw err;
  }

  const { error: doneErr } = await supabase.from("jobs").update({
    status: "done", output_data: result, completed_at: new Date().toISOString(),
  }).eq("id", job.id);

  if (doneErr) {
    console.error(`[Worker] Failed to update job ${job.id} to done:`, doneErr);
  }

  return result;
}

console.log(`[Worker] Starting compx-jobs (concurrency: ${CONCURRENCY})`);

const worker = new Worker("compx-jobs", processJob, {
  connection: redis, concurrency: CONCURRENCY,
  stalledInterval: 120_000,
  lockDuration: 60_000,
  limiter: { max: 5, duration: 60_000 },
});

worker.on("completed", (job) => console.log(`[Worker] ✓ ${job.data.type || job.name} job ${job.id} complete`));

worker.on("failed", async (job, err) => {
  console.error(`[Worker] ✗ ${job?.id} → ${err.message}`);
  if (job) {
    const { error: failErr } = await supabase.from("jobs").update({
      status: "failed", error: `${err.message} (Attempt ${job.attemptsMade})`,
    }).eq("id", job.id);
    if (failErr) console.error(`[Worker] Failed to update job ${job.id} to failed:`, failErr);
  }
});

worker.on("error", err => console.error("[Worker] Worker error:", err.message));

const leadEnrichWorker = new Worker("lead_enrichment", async (job) => {
  const { kind, input_data, user_id, orgId } = job.data;

  if (kind === "website" || kind === "social" || kind === "tripadvisor_review") {
    if (kind === "tripadvisor_review") {
      const { runTripadvisorEnrichJob } = await import("./jobs/enrichTripadvisorJob.js");
      return await runTripadvisorEnrichJob(input_data, user_id, job);
    }
    const result = await runEnrichJob(input_data, user_id);
    // FIX: was unconditional — charged even when runEnrichJob() returned a
    // genuine system failure (result.error set, e.g. fetch/HTTP error,
    // nothing actually completed). The "enrich" job type below already
    // gates on `!result?.error`; this path charged regardless, which
    // contradicts the documented billing policy ("only free outcomes are
    // genuine system failures... nothing was actually completed"). Now
    // consistent with the other charging call sites.
    if (!result?.error) {
      await chargeEnrichAttempt(user_id, orgId);
    }
    return result;
  } else if (kind === "ai") {
    return await runAiEnrichment(job.data, supabase);
  } else if (kind === "ebay_seller") {
    const { runEbaySellerEnrichJob } = await import("./jobs/enrichEbaySellerJob.js");
    const result = await runEbaySellerEnrichJob(input_data, user_id, job);
    if (result && result.sellerType && result.sellerType !== "unknown") {
      await chargeEnrichAttempt(user_id, orgId, 1); // 1 credit for ebay seller enrich
    }
    return result;
  }

  throw new Error(`Unknown enrichment kind: ${kind}`);
}, {
  connection: redis, concurrency: 2,
  limiter: { max: 10, duration: 60_000 },
});
leadEnrichWorker.on("completed", (job) => console.log(`[LeadEnrichment] ✓ ${job.data.kind} job ${job.id}`));
leadEnrichWorker.on("failed", (job, err) => console.error(`[LeadEnrichment] ✗ ${job?.data?.kind} job ${job?.id}:`, err.message));

attachDLQListener(worker, "compx-jobs");
pollSupabaseJobs(jobQueue, supabase);

const stopScheduler = startScheduler(supabase, redis, jobQueue);

console.log(`[Worker] 🚀 CompX Worker started — concurrency: ${CONCURRENCY}`);
console.log(`[Worker] Redis: ${REDIS_URL ? new URL(REDIS_URL).host : "not configured"}`);

const app = express();
if (process.env.ENABLE_BULL_BOARD === "true") {
  app.use("/admin/queues", createBullBoardRouter());
}
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: process.env.NODE_ENV === "production" ? (process.env.FRONTEND_URL || "http://localhost:3000") : "*" },
});

io.on("connection", (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);
  socket.on("join", ({ userId, jobId }) => {
    if (userId) socket.join(`user_${userId}`);
    if (jobId) socket.join(`job_${jobId}`);
  });
});

worker.on("progress", (job, progress) => {
  if (job.data?.user_id) {
    io.to(`user_${job.data.user_id}`).to(`job_${job.id}`).emit("lead.progress", progress);
  }
});

server.listen(WORKER_PORT, () => {
  console.log(`[Worker] 📊 Bull-Board & WS: http://localhost:${WORKER_PORT}/admin/queues`);
});

async function shutdown(signal) {
  console.log(`[Worker] ${signal} received — shutting down gracefully`);
  stopScheduler();
  await Promise.allSettled([
    worker.close(), leadEnrichWorker.close(), getBrowserPool().shutdown(), redis.quit(),
  ]);
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));