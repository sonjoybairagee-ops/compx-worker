/**
 * CompX Worker — src/index.js
 *
 * CHANGES (startup-optimized):
 *   1. hiringSignals, drip, webhook — disabled (পরে চালু করো)
 *   2. dripWorker — disabled (Next.js API depend করে, risky)
 *   3. dripQueue — শুধু declare রাখা হয়েছে (import error avoid)
 *   4. DISABLED_JOBS set যোগ — graceful skip with log
 *   5. Socket.IO CORS — production এ origin restrict করো
 */

import "dotenv/config";
import { Worker, Queue } from "bullmq";
import IORedis from "ioredis";
import { runEnrichJob }      from "./jobs/enrichJob.js";
import { runDiscoverScrape } from "./jobs/discoverScrapeJob.js";
import { runVerifyEmail }    from "./jobs/verifyEmailJob.js";
import { runPipelineFilter } from "./jobs/pipelineFilterJob.js";

// ── DISABLED JOBS (startup phase এ দরকার নেই) ────────────────────────────────
// পরে চালু করতে হলে শুধু comment সরাও এবং switch case uncomment করো
// import { runHiringSignals } from "./jobs/hiringSignalsJob.js";
// import { runWebhookJob }    from "./jobs/webhookJob.js";
// import { runDripJob }       from "./jobs/dripJob.js";

const DISABLED_JOBS = new Set(["hiring_signals", "webhook", "drip"]);

import { pollSupabaseJobs }                    from "./poller.js";
import { analyzeJobRisk, updateBrainFeedback } from "../lib/scrapingBrain.js";
import { getBestProxy }                        from "../lib/proxy.js";
import express                                 from "express";
import { createBullBoardRouter }               from "./config/bullBoard.js";
import { attachDLQListener }                   from "./config/dlqHandler.js";
import { Server }                              from "socket.io";
import http                                    from "http";
import { supabase }                            from "./config/supabase.js";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Config ────────────────────────────────────────────────────────────────────
const REDIS_URL   = process.env.REDIS_URL           || "redis://localhost:6379";
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || "3");

// ── Redis ─────────────────────────────────────────────────────────────────────
const redis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck:     false,
  tls: REDIS_URL.startsWith("rediss://") ? { rejectUnauthorized: false } : undefined,
  retryStrategy: (times) => {
    if (times > 5) return null;
    return Math.min(times * 500, 3000);
  },
});

redis.on("connect", () => console.log("[Worker] Redis connected"));
redis.on("error",   e  => console.error("[Worker] Redis error:", e.message));

// ── Queues ────────────────────────────────────────────────────────────────────
export const jobQueue  = new Queue("compx-jobs", { connection: redis });
export const dripQueue = new Queue("drip-jobs",  { connection: redis }); // declare রাখা — dispatcher এ reference আছে

// ── Platform job name normalizer ──────────────────────────────────────────────
const SCRAPE_JOB_NAMES = new Set([
  "discover_scrape",
  "google-maps-scrape",
  "linkedin-scrape",
  "instagram-biz-scrape",
  "youtube-scrape",
  "websites-scrape",
  "startup-db-scrape",
  "amazon-scrape",  // Amazon product search
]);

// ── Main job processor ────────────────────────────────────────────────────────
async function processJob(job) {
  const { input_data, user_id, billing_user_id } = job.data;
  const billingUserId = billing_user_id || user_id;
  let type = job.data.type || job.name;

  if (SCRAPE_JOB_NAMES.has(type)) type = "discover_scrape";

  // ── Disabled job check ────────────────────────────────────────────────────
  if (DISABLED_JOBS.has(type)) {
    console.warn(`[Worker] Job type "${type}" is disabled in startup mode — skipping`);
    await supabase.from("jobs").update({
      status:       "failed",
      error_detail: `Job type "${type}" is not available yet. Coming soon.`,
    }).eq("id", job.id);
    return { skipped: true, reason: "disabled_in_startup_mode" };
  }

  // ── Routing ───────────────────────────────────────────────────────────────
  const routingCtx = {
    domain:  input_data?.website || input_data?.domain,
    country: input_data?.country,
    type,
  };
  const routing = analyzeJobRisk(routingCtx);
  const proxy   = getBestProxy(routing);

  console.log(`[Worker] Job ${job.id} (${type}) → risk:${routing.riskLevel} proxy:${proxy?.id || "none"}`);

  await sleep(routing.delayMs);

  await supabase.from("jobs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", job.id);

  const startTime = Date.now();
  let result = null;

  try {
    switch (type) {
      case "enrich":
        result = await runEnrichJob(input_data, user_id, proxy);
        break;

      case "discover_scrape":
        result = await runDiscoverScrape(input_data, billingUserId, job, proxy);
        break;

      case "verify_email":
        result = await runVerifyEmail(input_data, user_id);
        break;

      case "pipeline_filter":
        result = await runPipelineFilter(input_data, billingUserId);
        break;

      // ── DISABLED (পরে uncomment করো) ─────────────────────────────────────
      // case "hiring_signals":
      //   result = await runHiringSignals(input_data, user_id, job);
      //   break;
      // case "webhook":
      //   result = await runWebhookJob(input_data);
      //   break;

      default:
        throw new Error(`Unknown job type: ${type}`);
    }

    // Proxy success feedback
    if (proxy) {
      await updateBrainFeedback({
        proxyId: proxy.id,
        success: true,
        latency: Date.now() - startTime,
        domain:  routingCtx.domain,
      });
    }

    // ── Child enrichment job chain ─────────────────────────────────────────
    // discover_scrape শেষে enrichment চাইলে domains queue তে দাও
    if (type === "discover_scrape" && input_data?.enrichments) {
      const { email, tech, ai } = input_data.enrichments;
      if ((email || tech || ai) && result?.leads?.length > 0) {
        const domains = [...new Set(result.leads.map(l => l.website).filter(Boolean))];
        if (domains.length > 0) {
          await jobQueue.add("enrich", {
            type:       "enrich",
            user_id,
            input_data: {
              domains,
              options:      input_data.enrichments,
              parentJobId:  job.id,
            },
          });
          console.log(`[Worker] Child enrich job queued for ${domains.length} domains`);
        }
      }
    }

  } catch (err) {
    if (proxy) {
      await updateBrainFeedback({ proxyId: proxy.id, success: false, domain: routingCtx.domain });
    }
    throw err;
  }

  await supabase.from("jobs")
    .update({ status: "done", output_data: result, completed_at: new Date().toISOString() })
    .eq("id", job.id);

  return result;
}

// ── compx-jobs Worker ─────────────────────────────────────────────────────────
console.log(`[Worker] Starting compx-jobs (concurrency: ${CONCURRENCY})`);

const worker = new Worker("compx-jobs", processJob, {
  connection:      redis,
  concurrency:     CONCURRENCY,
  stalledInterval: 30_000,
  lockDuration:    30_000,
  limiter: {
    max:      10,
    duration: 60_000, // max 10 jobs/min — anti-block
  },
});

worker.on("completed", (job) => {
  console.log(`[Worker] ✓ ${job.data.type || job.name} job ${job.id} complete`);
});

worker.on("failed", async (job, err) => {
  console.error(`[Worker] ✗ ${job?.id} → ${err.message}`);
  if (job) {
    await supabase.from("jobs").update({
      status:       "failed",
      error_detail: `${err.message} (Attempt ${job.attemptsMade})`,
    }).eq("id", job.id);
  }
});

worker.on("error", err => {
  console.error("[Worker] Worker error:", err.message);
});

// ── drip-jobs Worker — DISABLED ───────────────────────────────────────────────
// dripJob Next.js API এর উপর depend করে — আলাদা server এ problem হবে
// চালু করতে হলে নিচের comment সরাও এবং runDripJob import করো
//
// const dripWorker = new Worker("drip-jobs", async (job) => {
//   return await runDripJob(job.data);
// }, {
//   connection:  redis,
//   concurrency: CONCURRENCY,
//   limiter: { max: 5, duration: 1000 },
// });
// dripWorker.on("completed", (job) => console.log(`[DripWorker] Done: ${job.id}`));
// dripWorker.on("failed", (job, err) => console.error(`[DripWorker] Failed: ${job?.id} → ${err.message}`));

console.log("[Worker] drip-jobs processor DISABLED (startup mode)");

// ── DLQ listener ──────────────────────────────────────────────────────────────
attachDLQListener(worker, "compx-jobs");

// ── Supabase poller (Redis down হলে fallback) ─────────────────────────────────
pollSupabaseJobs(jobQueue, supabase);

console.log(`[Worker] 🚀 CompX Worker started — concurrency: ${CONCURRENCY}`);
console.log(`[Worker] Redis: ${REDIS_URL}`);
console.log(`[Worker] Disabled jobs: ${[...DISABLED_JOBS].join(", ")}`);

// ── Bull-Board + WebSocket ────────────────────────────────────────────────────
const app = express();
app.use("/admin/queues", createBullBoardRouter());

const server = http.createServer(app);

// TODO: production এ origin restrict করো
// origin: process.env.FRONTEND_URL || "http://localhost:3000"
const io = new Server(server, {
  cors: { origin: process.env.NODE_ENV === "production"
    ? (process.env.FRONTEND_URL || "http://localhost:3000")
    : "*"
  },
});

io.on("connection", (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);
  socket.on("join", ({ userId, jobId }) => {
    if (userId) socket.join(`user_${userId}`);
    if (jobId)  socket.join(`job_${jobId}`);
  });
});

// BullMQ progress → Socket.IO broadcast
worker.on("progress", (job, progress) => {
  if (job.data?.user_id) {
    io.to(`user_${job.data.user_id}`).to(`job_${job.id}`).emit("lead.progress", progress);
  }
});

server.listen(3001, () => {
  console.log("[Worker] 📊 Bull-Board & WS: http://localhost:3001/admin/queues");
});