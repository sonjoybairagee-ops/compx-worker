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
import { createClient } from "@supabase/supabase-js";
import { runEnrichJob }    from "./jobs/enrichJob.js";
import { runDeepScrape }   from "./jobs/deepScrapeJob.js";
import { runVerifyEmail }  from "./jobs/verifyEmailJob.js";
import { pollSupabaseJobs } from "./poller.js";

// ── Config ────────────────────────────────────────────────────────────────────
const REDIS_URL     = process.env.REDIS_URL     || "redis://localhost:6379";
const SUPABASE_URL  = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CONCURRENCY   = parseInt(process.env.WORKER_CONCURRENCY || "3");

// ── Supabase client ───────────────────────────────────────────────────────────
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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
  const { type, input_data, user_id } = job.data;

  console.log(`[Worker] Processing job ${job.id} — type: ${type} — ${input_data?.name || input_data?.website || ""}`);

  // Update status to running in Supabase
  await supabase
    .from("jobs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", job.id);

  let result = null;

  switch (type) {
    case "enrich":
      result = await runEnrichJob(input_data, user_id);
      break;
    case "deep_scrape":
      result = await runDeepScrape(input_data, user_id);
      break;
    case "verify_email":
      result = await runVerifyEmail(input_data, user_id);
      break;
    default:
      throw new Error(`Unknown job type: ${type}`);
  }

  // Mark done + save output
  await supabase
    .from("jobs")
    .update({
      status:       "done",
      output_data:  result,
      completed_at: new Date().toISOString(),
    })
    .eq("id", job.id);

  console.log(`[Worker] ✓ Job ${job.id} done — ${type}`);
  return result;
}

// ── BullMQ Worker ─────────────────────────────────────────────────────────────
const worker = new Worker("compx-jobs", processJob, {
  connection:  redis,
  concurrency: CONCURRENCY,
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
    await supabase
      .from("jobs")
      .update({
        status:     job.attemptsMade >= 3 ? "failed" : "pending",
        error:      err.message,
        retry_count: job.attemptsMade,
      })
      .eq("id", job.id);
  }
});

worker.on("error", err => {
  console.error("[Worker] Worker error:", err.message);
});

// ── Supabase poller (fallback if Redis unavailable) ────────────────────────────
// Polls jobs table every 10s and enqueues pending jobs to BullMQ
pollSupabaseJobs(jobQueue, supabase);

console.log(`[Worker] 🚀 CompX Worker started — concurrency: ${CONCURRENCY}`);
console.log(`[Worker] Redis: ${REDIS_URL}`);
console.log(`[Worker] Supabase: ${SUPABASE_URL}`);
