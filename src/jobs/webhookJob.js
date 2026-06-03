/**
 * CompX Worker — src/jobs/webhookJob.js
 * Processes webhook delivery with exponential backoff for resilience.
 */

import { supabase } from "../config/supabase.js";

export async function runWebhookJob(data) {
  const { webhookUrl, jobId, leads, userId, attempt = 1 } = data;

  console.log(`[WebhookJob] Sending ${leads.length} leads to ${webhookUrl} (Attempt ${attempt})`);

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId, leads, event: "enrichment_completed" }),
    });

    if (!res.ok) {
      throw new Error(`Server returned status ${res.status}`);
    }

    console.log(`[WebhookJob] Delivered successfully to ${webhookUrl}`);
    return { success: true, delivered: leads.length };

  } catch (err) {
    console.error(`[WebhookJob] Delivery failed: ${err.message}`);
    
    // Throwing error allows BullMQ to handle retries natively using exponential backoff
    throw err;
  }
}
