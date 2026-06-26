/**
 * CompX Worker — src/jobs/webhookJob.js (FIXED)
 *
 * Fixes applied:
 *   1. Request timeout (10s) — infinite hang বন্ধ
 *   2. leads null/undefined safety check
 *   3. webhookUrl validation
 */

import { supabase } from "../config/supabase.js";

const WEBHOOK_TIMEOUT_MS = 10_000; // 10 seconds

export async function runWebhookJob(data) {
  const { webhookUrl, jobId, leads, userId, attempt = 1 } = data;

  // FIX 2 & 3: null safety + validation
  const leadList = leads ?? [];
  if (!webhookUrl) throw new Error("webhookUrl is required");

  console.log(`[WebhookJob] Sending ${leadList.length} leads to ${webhookUrl} (Attempt ${attempt})`);

  // FIX 1: AbortController দিয়ে timeout
  // আগে: timeout ছিল না → endpoint respond না করলে worker slot আটকে থাকত
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const res = await fetch(webhookUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        job_id: jobId,
        leads:  leadList,
        event:  "enrichment_completed",
        sent_at: new Date().toISOString(),
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`Webhook returned status ${res.status}`);
    }

    console.log(`[WebhookJob] ✅ Delivered ${leadList.length} leads to ${webhookUrl}`);
    return { success: true, delivered: leadList.length };

  } catch (err) {
    clearTimeout(timer);

    // AbortError মানে timeout
    if (err.name === "AbortError") {
      throw new Error(`Webhook timeout after ${WEBHOOK_TIMEOUT_MS / 1000}s — ${webhookUrl}`);
    }

    console.error(`[WebhookJob] Delivery failed: ${err.message}`);
    // BullMQ native retry চলবে (exponential backoff)
    throw err;
  }
}
