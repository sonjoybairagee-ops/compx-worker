// worker/src/index.js
//
// MIGRATED: BullMQ + ioredis -> pg-boss (Postgres-only queue) + Supabase.
//
// What changed vs. the Redis version:
//   - No ioredis client, no REDIS_URL, no `connection: redis`.
//   - BullMQ's `new Worker(name, handler, {connection})` -> pg-boss's
//     `boss.work(name, options, handler)`.
//   - BullMQ's `queue.add()` -> `boss.send()`.
//   - The Redis `SET NX EX 300` dedupe lock for enrichment dispatch is now
//     pg-boss's native `singletonKey` + `singletonSeconds` (same effect:
//     "don't create another job with this key for 300s").
//   - `job.updateProgress()` + `worker.on('progress')` doesn't exist in
//     pg-boss, so progress is now emitted directly via Socket.io from
//     inside the handler (io is created before the workers start).
//   - The BullMQ `moveToDelayed` circuit-breaker retry is now done by
//     scheduling a fresh pg-boss job with `startAfter` and completing the
//     current attempt (pg-boss doesn't support "delay this exact attempt
//     in place" the way BullMQ did).
//
// STILL TODO (needs files not shared yet):
//   - config/dlqHandler.js is no longer used — pg-boss's `deadLetter` queue
//     option (set in config/pgboss.js) replaces it natively. If you had
//     custom DLQ alerting logic in there, port it to a `boss.work()`
//     handler on the `${queue}-dlq` queues.
//   - config/bullBoard.js (the /admin/queues dashboard) has no pg-boss
//     equivalent. Either drop it, or I can help you build a small custom
//     admin view querying pg-boss's tables directly if you share how it's
//     used.
//   - @compx/worker-scheduler's `startScheduler(supabase, redis, jobQueue)`
//     still expects a redis client + BullMQ queue — share that package and
//     I'll port it to use `boss` instead.

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: true });

import { runEnrichJob } from "./jobs/enrichJob.js";
import { runVerifyEmail } from "./jobs/verifyEmailJob.js";
import { runPipelineFilter } from "./jobs/pipelineFilterJob.js";
import { runDripJob } from "./jobs/dripJob.js";
import { runHiringSignals } from "./jobs/hiringSignalsJob.js";
import { pollSupabaseJobs } from "./poller.js";
import express from "express";
import { Server } from "socket.io";
import http from "http";
import { supabase } from "./config/supabase.js";
import { getBoss, QUEUES } from "./config/pgboss.js";

import { getPlugin } from "@compx/worker-registry";
import { runAiEnrichment } from "@compx/worker-ai-enrichment";
import { getBrowserPool, getProxyManager, analyzeJobRisk, ENRICHMENT_COSTS } from "@compx/scraper-core";
import { startScheduler } from "@compx/worker-scheduler";

// drip is now handled by a dedicated boss.work() on QUEUES.DRIP_JOBS below
const DISABLED_JOBS = new Set(["webhook"]);

const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || "3");
const WORKER_PORT = parseInt(process.env.WORKER_PORT || process.env.PORT || "3001");

const SCRAPE_JOB_NAMES = new Set([
  "discover_scrape", "google-maps-scrape", "linkedin-scrape",
  "instagram-biz-scrape", "youtube-scrape", "websites-scrape",
  "startup-db-scrape", "amazon-scrape", "facebook-scrape", "ebay-scrape", "tripadvisor-scrape",
]);

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

async function main() {
  const boss = await getBoss();
  console.log(`[Worker] Starting compx-jobs (concurrency: ${CONCURRENCY})`);

  // --- Socket.io / Express setup moved BEFORE the workers start, so job
  // handlers can emit progress directly (no more updateProgress/'progress'
  // event indirection — pg-boss has no equivalent of that BullMQ feature). ---
  const app = express();
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

  async function emitProgress(job, data) {
    if (job?.data?.user_id) {
      io.to(`user_${job.data.user_id}`).to(`job_${job.id}`).emit("lead.progress", data);
    }
    // Sync progress to Supabase 'jobs' table so Supabase Realtime client receives it
    try {
      await supabase
        .from("jobs")
        .update({ progress: data })
        .eq("id", job.data.id);
    } catch (err) {
      console.warn(`[Worker] Supabase progress sync failed for job ${job.id}:`, err.message);
    }
  }

  async function processJob(job) {
    const { input_data, user_id, billing_user_id } = job.data;
    const billingUserId = billing_user_id || user_id;
    let type = job.data.type;

    if (SCRAPE_JOB_NAMES.has(type)) type = "discover_scrape";

    if (DISABLED_JOBS.has(type)) {
      console.warn(`[Worker] Job type "${type}" is disabled — skipping`);
      await supabase.from("jobs").update({
        status: "failed", error: `Job type "${type}" is not available yet.`,
      }).eq("id", job.data.id);
      return { skipped: true, reason: "disabled" };
    }

    const routingCtx = { domain: input_data?.website || input_data?.domain, country: input_data?.country, type };
    const routing = analyzeJobRisk(routingCtx);
    const proxy = await getProxyManager().getBest(routing);

    console.log(`[Worker] Job ${job.id} (${type}) → risk:${routing.riskLevel} proxy:${proxy?.id || "none"}`);

    await supabase.from("jobs").update({ status: "running", started_at: new Date().toISOString() }).eq("id", job.data.id);

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
            proxy,
            updateProgress: (data) => emitProgress(job, data),
            dispatchEnrichment: async (kind, payload) => {
              const dedupId = payload.domain || payload.leadId;
              if (!dedupId) return;

              // REPLACES the Redis `SET enrich_lock:${kind}:${dedupId} NX EX 300`
              // lock: pg-boss's singletonKey/singletonSeconds guarantee only
              // one active job with this key can exist within the window —
              // boss.send() silently no-ops (returns null) if one already does.
              const jobId = await boss.send(QUEUES.LEAD_ENRICHMENT, {
                type: "lead_enrichment",
                kind,
                user_id: billingUserId,
                orgId: input_data?.orgId ?? null,
                input_data: { ...payload, parentJobId: job.id, options: input_data.enrichments },
              }, {
                singletonKey: `${kind}:${dedupId}`,
                singletonSeconds: 300,
              });

              if (jobId) {
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

        case "hiring_signals":
          result = await runHiringSignals(input_data, user_id, job);
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
        const jitter = Math.floor(Math.random() * 60); // 0-60s
        const delaySeconds = (10 * 60) + jitter;
        console.warn(`[Worker] Circuit Open for job ${job.id}, rescheduling in ${delaySeconds}s`);

        // pg-boss can't "delay this exact attempt in place" like BullMQ's
        // moveToDelayed. Instead: schedule a brand-new job to run later,
        // and let this attempt end normally (not as a failure — a
        // CIRCUIT_OPEN isn't the job's fault, so it shouldn't burn a
        // retry_count / retry attempt).
        await boss.send(QUEUES.JOBS, job.data, { startAfter: delaySeconds });
        return { rescheduled: true, reason: "circuit_open", delaySeconds };
      }
      throw err;
    }

    const { error: doneErr } = await supabase.from("jobs").update({
      status: "done", output_data: result, completed_at: new Date().toISOString(),
    }).eq("id", job.data.id);

    if (doneErr) {
      console.error(`[Worker] Failed to update job ${job.id} to done:`, doneErr);
    }

    return result;
  }

  // --- Main job worker ---
  await boss.work(
    QUEUES.JOBS,
    { batchSize: 1, pollingIntervalSeconds: 2, teamSize: CONCURRENCY, teamConcurrency: CONCURRENCY },
    async ([job]) => {
      try {
        const result = await processJob(job);
        console.log(`[Worker] ✓ ${job.data.type} job ${job.id} complete`);
        return result;
      } catch (err) {
        console.error(`[Worker] ✗ ${job.id} → ${err.message}`);
        const { error: failErr } = await supabase.from("jobs").update({
          status: "failed", error: `${err.message} (Attempt ${job.retrycount ?? 0})`,
        }).eq("id", job.data.id);
        if (failErr) console.error(`[Worker] Failed to update job ${job.id} to failed:`, failErr);
        throw err; // lets pg-boss's retryLimit/deadLetter handle it
      }
    }
  );

  // --- Lead enrichment worker ---
  await boss.work(
    QUEUES.LEAD_ENRICHMENT,
    { batchSize: 1, pollingIntervalSeconds: 2, teamSize: 2, teamConcurrency: 2 },
    async ([job]) => {
      const { kind, input_data, user_id, orgId } = job.data;
      try {
        let result;
        if (kind === "website" || kind === "social" || kind === "tripadvisor_review") {
          if (kind === "tripadvisor_review") {
            const { runTripadvisorEnrichJob } = await import("./jobs/enrichTripadvisorJob.js");
            result = await runTripadvisorEnrichJob(input_data, user_id, job);
          } else {
            result = await runEnrichJob(input_data, user_id);
            if (!result?.error) {
              await chargeEnrichAttempt(user_id, orgId);
            }
          }
        } else if (kind === "ai") {
          result = await runAiEnrichment(job.data, supabase);
        } else if (kind === "ebay_seller") {
          const { runEbaySellerEnrichJob } = await import("./jobs/enrichEbaySellerJob.js");
          result = await runEbaySellerEnrichJob(input_data, user_id, job);
          if (result && result.sellerType && result.sellerType !== "unknown") {
            await chargeEnrichAttempt(user_id, orgId, 1);
          }
        } else {
          throw new Error(`Unknown enrichment kind: ${kind}`);
        }
        console.log(`[LeadEnrichment] ✓ ${kind} job ${job.id}`);
        return result;
      } catch (err) {
        console.error(`[LeadEnrichment] ✗ ${kind} job ${job.id}:`, err.message);
        throw err;
      }
    }
  );

  // --- Drip / Sequence worker ---
  await boss.work(
    QUEUES.DRIP_JOBS,
    { batchSize: 1, pollingIntervalSeconds: 5, teamSize: 3, teamConcurrency: 3 },
    async ([job]) => {
      try {
        const result = await runDripJob(job.data);
        console.log(`[DripWorker] ✓ Drip job ${job.id} complete`);
        return result;
      } catch (err) {
        console.error(`[DripWorker] ✗ ${job.id}:`, err.message);
        throw err;
      }
    }
  );

  // --- Campaign cold-email worker ---
  await boss.work(
    QUEUES.CAMPAIGN_JOBS,
    { batchSize: 1, pollingIntervalSeconds: 5, teamSize: 2, teamConcurrency: 2 },
    async ([job]) => {
      try {
        const { name, data } = job.data;
        if (name === "campaign-cold-email") {
          // Call internal outreach preview + send
          const APP_URL = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
          const previewRes = await fetch(`${APP_URL}/api/outreach/preview`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-internal-service-key": process.env.INTERNAL_SERVICE_KEY || "",
              "x-org-id": data.orgId,
              "x-user-id": data.userId,
            },
            body: JSON.stringify({ leadId: data.leadId, customNote: data.customNote || "" }),
          });
          if (!previewRes.ok) throw new Error(`Preview failed: ${previewRes.status}`);
          const { subject, body } = await previewRes.json();
          const sendRes = await fetch(`${APP_URL}/api/outreach/send`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-internal-service-key": process.env.INTERNAL_SERVICE_KEY || "",
              "x-org-id": data.orgId,
              "x-user-id": data.userId,
            },
            body: JSON.stringify({ leadId: data.leadId, campaignId: data.campaignId, subject, body }),
          });
          if (!sendRes.ok) throw new Error(`Send failed: ${sendRes.status}`);
          console.log(`[CampaignWorker] ✓ cold-email sent for lead ${data.leadId}`);
        } else if (name === "campaign-cold-dm") {
          // DM jobs are manual queue entries — no automated send yet
          console.log(`[CampaignWorker] DM job ${job.id} — manual review required`);
        } else {
          console.warn(`[CampaignWorker] Unknown campaign job: ${name}`);
        }
      } catch (err) {
        console.error(`[CampaignWorker] ✗ ${job.id}:`, err.message);
        throw err;
      }
    }
  );

  // --- AI jobs worker ---
  await boss.work(
    QUEUES.AI_JOBS,
    { batchSize: 1, pollingIntervalSeconds: 5, teamSize: 2, teamConcurrency: 2 },
    async ([job]) => {
      try {
        const result = await runAiEnrichment(job.data, supabase);
        console.log(`[AiWorker] ✓ AI job ${job.id} complete`);
        return result;
      } catch (err) {
        console.error(`[AiWorker] ✗ ${job.id}:`, err.message);
        throw err;
      }
    }
  );

  pollSupabaseJobs(boss, supabase);

  // ── Scheduler — popular search pre-scraping ──────────────────────────────
  const SYSTEM_USER_ID = process.env.SYSTEM_USER_ID;
  if (SYSTEM_USER_ID) {
    const stopScheduler = startScheduler(supabase, boss, SYSTEM_USER_ID);
    process.once("SIGTERM", stopScheduler);
    process.once("SIGINT", stopScheduler);
    console.log(`[Worker] 🕐 Scheduler started for popular search pre-scraping`);
  } else {
    console.warn("[Worker] SYSTEM_USER_ID not set — scheduler disabled (pre-scraping skipped)");
  }

  console.log(`[Worker] 🚀 CompX Worker started — concurrency: ${CONCURRENCY}`);
  console.log(`[Worker] Queue backend: Postgres (pg-boss) via SUPABASE_DB_URL`);

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.warn(
        `[Worker] ⚠️ Port ${WORKER_PORT} is already in use. The queue consumers will run normally, but the Socket.io/express server cannot listen on this port.`
      );
    } else {
      console.error("[Worker] Server error:", err);
    }
  });

  server.listen(WORKER_PORT, () => {
    console.log(`[Worker] 📡 Socket.io: http://localhost:${WORKER_PORT}`);
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Worker] ${signal} received — shutting down gracefully`);

    // stopScheduler?.();

    const closeWithTimeout = (label, promise, ms = 15000) =>
      Promise.race([
        promise,
        new Promise((resolve) =>
          setTimeout(() => {
            console.warn(`[Worker] ${label} did not close within ${ms}ms — continuing shutdown anyway`);
            resolve(undefined);
          }, ms)
        ),
      ]);

    await Promise.allSettled([
      closeWithTimeout("browserPool", getBrowserPool().shutdown()),
      closeWithTimeout("pg-boss", boss.stop({ graceful: true, timeout: 15000 })),
    ]);

    process.exit(0);
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[Worker] Fatal startup error:", err);
  process.exit(1);
});
