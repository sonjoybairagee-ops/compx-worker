/**
 * lib/terminalLogger.js
 * Buffered terminal logger — প্রতি log এ Supabase call নয়, batch এ flush করে
 *
 * আগের সমস্যা: প্রতিটা log() call এ SELECT + UPDATE = ২টা DB call
 * Fix: memory buffer → প্রতি N log বা job শেষে একবারে flush
 */

import { supabase } from "../config/supabase.js";

const FLUSH_EVERY = 10;        // প্রতি ১০ log এ auto-flush
const FLUSH_INTERVAL_MS = 5000; // অথবা ৫ সেকেন্ড পরপর

/**
 * createLogger(jobId) → { log, flush, close }
 *
 * ব্যবহার:
 *   const logger = createLogger(jobId);
 *   await logger.log("Starting...");
 *   await logger.close(); // job শেষে call করুন
 */
export function createLogger(jobId) {
  const buffer = [];
  let flushTimer = null;
  let flushing = false;

  // Auto-flush timer
  flushTimer = setInterval(() => {
    if (buffer.length > 0) _flush();
  }, FLUSH_INTERVAL_MS);

  async function _flush() {
    if (flushing || buffer.length === 0) return;
    flushing = true;

    const toFlush = buffer.splice(0, buffer.length); // buffer clear করুন

    try {
      const { data } = await supabase
        .from("jobs")
        .select("terminal_logs")
        .eq("id", jobId)
        .single();

      const existing = data?.terminal_logs || [];
      const merged = [...existing, ...toFlush];

      await supabase
        .from("jobs")
        .update({ terminal_logs: merged })
        .eq("id", jobId);
    } catch (e) {
      console.warn(`[Logger] Flush failed for job ${jobId}:`, e.message);
    } finally {
      flushing = false;
    }
  }

  return {
    /**
     * log(message) — buffer এ রাখে, threshold হলে flush করে
     */
    async log(message) {
      const entry = { time: new Date().toISOString(), message };
      console.log(`[Job ${jobId}] ${message}`);
      buffer.push(entry);

      if (buffer.length >= FLUSH_EVERY) {
        await _flush();
      }
    },

    /**
     * flush() — manually flush করুন (progress update এর আগে)
     */
    async flush() {
      await _flush();
    },

    /**
     * close() — job শেষে call করুন, timer বন্ধ করে, remaining logs flush করে
     */
    async close() {
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
      }
      await _flush();
    },
  };
}

/**
 * Simple one-shot logger (backward compatible)
 * পুরনো code এ logToTerminal(jobId, msg) → এটা দিয়ে replace করুন
 * তবে createLogger() ব্যবহার করাই ভালো
 */
export async function logToTerminal(jobId, message) {
  console.log(`[Job ${jobId}] ${message}`);
  try {
    const { data } = await supabase
      .from("jobs")
      .select("terminal_logs")
      .eq("id", jobId)
      .single();

    const logs = data?.terminal_logs || [];
    logs.push({ time: new Date().toISOString(), message });

    await supabase
      .from("jobs")
      .update({ terminal_logs: logs })
      .eq("id", jobId);
  } catch {}
}
