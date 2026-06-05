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
import { runDeepScrape }   from "./jobs/deepScrapeJob.js";
import { runDiscoverScrape } from "./jobs/discoverScrapeJob.js";
import { runVerifyEmail }  from "./jobs/verifyEmailJob.js";
import { runWebhookJob }   from "./jobs/webhookJob.js";
import { pollSupabaseJobs } from "./poller.js";
import { analyzeJobRisk, updateBrainFeedback } from "../lib/scrapingBrain.js";
import { getBestProxy } from "../lib/proxy.js";
import express from "express";
import { createBullBoardRouter } from "./config/bullBoard.js";
import { attachDLQListener } from "./config/dlqHandler.js";

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
      case "deep_scrape":
        result = await runDeepScrape(input_data, user_id, proxy);
        break;
      case "discover_scrape":
        result = await runDiscoverScrape(input_data, user_id, job.id, proxy);
        break;
      case "verify_email":
        result = await runVerifyEmail(input_data, user_id);
        break;
      case "webhook":
        result = await runWebhookJob(input_data);
        break;
      default:
        throw new Error(`Unknown job type: ${type}`);
    }
    case "google-maps-scrape":
case "discover_scrape":
  result = await runDiscoverScrape(input_data, user_id, job.id, proxy);
  break;

    // proxy success feedback
    if (proxy) {
      await updateBrainFeedback({
        proxyId: proxy.id,
        success: true,
        latency: Date.now() - startTime,
        domain: routingCtx.domain
      });
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

// ── Bull-Board Admin Dashboard ─────────────────────────────
const app = express();
app.use("/admin/queues", createBullBoardRouter());
app.listen(3001, () => {
  console.log("[Worker] 📊 Bull-Board: http://localhost:3001/admin/queues");
});
