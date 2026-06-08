/**
 * CompX Worker — src/index.js
 * BullMQ job processor + Crawlee + Puppeteer deep scraper
 *
 * Pipeline:
 * Supabase jobs table (pending) → BullMQ queue → Worker
 * → deep scrape → normalize → enrich → store back to Supabase
 */

import "dotenv/config";
import { Worker, Queue } from "bullmq";
import IORedis from "ioredis";
import { runEnrichJob }    from "./jobs/enrichJob.js";
import { runDiscoverScrape } from "./jobs/discoverScrapeJob.js";
import { runHiringSignals } from "./jobs/hiringSignalsJob.js";
import { runVerifyEmail }  from "./jobs/verifyEmailJob.js";
import { runWebhookJob }   from "./jobs/webhookJob.js";
import { runPipelineFilter } from "./jobs/pipelineFilterJob.js";
import { pollSupabaseJobs } from "./poller.js";
import { analyzeJobRisk, updateBrainFeedback } from "../lib/scrapingBrain.js";
import { getBestProxy } from "../lib/proxy.js";
import express from "express";
import { createBullBoardRouter } from "./config/bullBoard.js";
import { attachDLQListener } from "./config/dlqHandler.js";
import { Server } from "socket.io";
import http from "http";

// helper
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Config ────────────────────────────────────────────────────────────────────
const REDIS_URL     = process.env.REDIS_URL     || "redis://localhost:6379";
const CONCURRENCY   = parseInt(process.env.WORKER_CONCURRENCY || "3");

import { supabase } from "./config/supabase.js";

// ── Redis connection ──────────────────────────────────────────────────────────
// Upstash requires TLS — rediss:// URL handles this automatically
// maxRetriesPerRequest: null is required by BullMQ
const redis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck:     false,
  tls: REDIS_URL.startsWith("rediss://") ? {
    rejectUnauthorized: false, // Upstash self-signed cert
  } : undefined,
  retryStrategy: (times) => {
    if (times > 5) return null; // stop retrying after 5 attempts
    return Math.min(times * 500, 3000);
  },
});

redis.on("connect", () => console.log("[Worker] Redis connected"));
redis.on("error",   e  => console.error("[Worker] Redis error:", e.message));

// ── BullMQ queue ──────────────────────────────────────────────────────────────
export const jobQueue = new Queue("compx-jobs", { connection: redis });

// ── Job dispatcher ────────────────────────────────────────────────────────────
async function processJob(job) {
  const { input_data, user_id } = job.data;
  const type = job.data.type || job.name; // Fallback to job.name if job.data.type is undefined

  // ── Routing decision ──────────────────────────────────────
  const routingCtx = {
    domain: input_data?.website || input_data?.domain,
    country: input_data?.country,
    type,
  };
  const routing = analyzeJobRisk(routingCtx);
  const proxy = getBestProxy(routing);

  console.log(`[Worker] Job ${job.id} → risk:${routing.riskLevel} geo:${routing.preferredGeo} proxy:${proxy?.id}`);

  // delay based on risk level
  await sleep(routing.delayMs);

  // status update
  await supabase
    .from("jobs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", job.id);

  // ── Execute with proxy + track result ─────────────────────
  const startTime = Date.now();
  let result = null;

  try {
    switch (type) {
      case "enrich":
        result = await runEnrichJob(input_data, user_id, proxy);
        break;
      case "discover_scrape":
        result = await runDiscoverScrape(input_data, user_id, job, proxy);
        break;
      case "hiring_signals":
        result = await runHiringSignals(input_data, user_id, job);
        break;
      case "verify_email":
        result = await runVerifyEmail(input_data, user_id);
        break;
      case "webhook":
        result = await runWebhookJob(input_data);
        break;
      case "pipeline_filter":
        result = await runPipelineFilter(input_data, user_id);
        break;
      default:
        throw new Error(`Unknown job type: ${type}`);
    }

    // proxy success feedback
    if (proxy) {
      await updateBrainFeedback({
        proxyId: proxy.id,
        success: true,
        latency: Date.now() - startTime,
        domain: routingCtx.domain
      });
    }

    // ── Chain of Jobs: Dispatch Child Enrichment Job if requested ──
    if (type === "discover_scrape" && input_data?.enrichments) {
      const { email, tech, ai } = input_data.enrichments;
      if ((email || tech || ai) && result?.leads?.length > 0) {
        const domains = [...new Set(result.leads.map(l => l.website).filter(Boolean))];
        if (domains.length > 0) {
          await jobQueue.add("enrich", {
            type: "enrich",
            user_id,
            input_data: {
              domains,
              options: input_data.enrichments,
              parentJobId: job.id
            }
          });
          console.log(`[Worker] Enqueued child enrichment job for ${domains.length} domains`);
        }
      }
    }

  } catch (err) {
    // proxy fail feedback
    if (proxy) {
      await updateBrainFeedback({
        proxyId: proxy.id,
        success: false,
        domain: routingCtx.domain
      });
    }
    throw err;
  }

  await supabase
    .from("jobs")
    .update({ status: "done", output_data: result, completed_at: new Date().toISOString() })
    .eq("id", job.id);

  return result;
}

// ── BullMQ Worker ─────────────────────────────────────────────────────────────
const worker = new Worker("compx-jobs", processJob, {
  connection:      redis,
  concurrency:     CONCURRENCY,
  stalledInterval: 30_000, // Redis-এ check প্রতি ৩০ সেকেন্ডে (আগে ~১ সেকেন্ড ছিল)
  lockDuration:    30_000, // job lock ৩০ সেকেন্ড থাকবে
  limiter: {
    max:      10,
    duration: 60_000, // max 10 jobs per minute — anti-block
  },
});

worker.on("completed", (job, result) => {
  console.log(`[Worker] ✓ ${job.data.type} job ${job.id} complete`);
});

worker.on("progress", (job, progress) => {
  // We'll emit the event using Socket.IO below
});

worker.on("failed", async (job, err) => {
  console.error(`[Worker] ✗ Job ${job?.id} failed:`, err.message);

  if (job) {
    const isFinal = job.attemptsMade >= (job.opts.attempts ?? 3);
    
    await supabase
      .from("jobs")
      .update({
        status:     isFinal ? "failed" : "pending",
        error:      err.message,
        retry_count: job.attemptsMade,
      })
      .eq("id", job.data.id || job.id);
  }
});

worker.on("error", err => {
  console.error("[Worker] Worker error:", err.message);
});

// ── DLQ: সব retry শেষ হলে failed job DLQ-তে পাঠাও ──
attachDLQListener(worker, "compx-jobs");

// ── Supabase poller (fallback if Redis unavailable) ────────────────────────────
// Polls jobs table every 10s and enqueues pending jobs to BullMQ
pollSupabaseJobs(jobQueue, supabase);

console.log(`[Worker] 🚀 CompX Worker started — concurrency: ${CONCURRENCY}`);
console.log(`[Worker] Redis: ${REDIS_URL}`);

// ── Bull-Board & WebSocket Server ─────────────────────────────
const app = express();
app.use("/admin/queues", createBullBoardRouter());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

io.on("connection", (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);
  
  socket.on("join", ({ userId, jobId }) => {
    if (userId) socket.join(`user_${userId}`);
    if (jobId) socket.join(`job_${jobId}`);
    console.log(`[Socket] ${socket.id} joined rooms: user_${userId}, job_${jobId}`);
  });
});

// Broadcast progress events from BullMQ to connected WebSocket clients
worker.on("progress", (job, progress) => {
  if (job.data && job.data.user_id) {
    const userId = job.data.user_id;
    const jobId = job.id;
    // Broadcast to the user's room and the job's specific room
    io.to(`user_${userId}`).to(`job_${jobId}`).emit("lead.progress", progress);
  }
});

server.listen(3001, () => {
  console.log("[Worker] 📊 Bull-Board & WS: http://localhost:3001");
});
