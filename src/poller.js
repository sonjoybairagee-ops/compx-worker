/**
 * Polls Supabase `jobs` table and sends jobs into pg-boss.
 *
 * Same reconcile/backoff logic as your original BullMQ poller, just with
 * BullMQ's `queue.getJob()/queue.add()` swapped for pg-boss's
 * `boss.getJobById()/boss.send()`. The "transient infra error" distinction
 * (Redis outage vs. real job failure) is kept, but now it's Postgres
 * connection errors instead of Redis ones.
 */

const POLL_INTERVAL = 8_000;   // 8 s safety-net — Supabase Realtime is the primary trigger
const BATCH_SIZE = 10;
const DB_CALL_TIMEOUT = 10_000;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

// Distinguishes "Postgres/connection is having a bad time" from "this
// specific job is broken". Only the latter should count toward retry_count
// or mark a row failed.
function isTransientInfraError(e) {
  const msg = String(e?.message || e || "");
  return (
    msg.includes("Connection terminated") ||
    msg.includes("timed out") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("connection is closed") ||
    msg.includes("too many clients") // Supabase connection-limit hiccups
  );
}

/**
 * @param {import('pg-boss')} boss - started pg-boss instance from config/pgboss.js
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export function pollSupabaseJobs(boss, supabase) {
  let isPolling = false;

  const poll = async () => {
    if (isPolling) return;
    isPolling = true;

    try {
      const { data: jobs, error } = await supabase
        .from("jobs")
        .select("*")
        .eq("status", "pending")
        .lt("retry_count", 3)
        .order("priority", { ascending: true })
        .order("created_at", { ascending: true })
        .limit(BATCH_SIZE);

      if (error) throw error;
      if (!jobs?.length) return;

      console.log(`[Poller] Found ${jobs.length} pending jobs`);

      for (const job of jobs) {
        try {
          // Same "only reconcile if already attempted" optimization as
          // before — a fresh job (retry_count === 0) can't already exist
          // in pg-boss, since this poller is the only thing that adds them.
          if ((job.retry_count || 0) > 0) {
            const existing = await withTimeout(
              boss.getJobById("compx-jobs", job.id),
              DB_CALL_TIMEOUT,
              `getJobById(${job.id})`
            );
            if (existing) {
              const state = existing.state; // 'created'|'active'|'completed'|'failed'|'cancelled'|'retry'
              if (state === "completed") {
                await supabase
                  .from("jobs")
                  .update({ status: "done", completed_at: new Date().toISOString() })
                  .eq("id", job.id);
                continue;
              }
              if (state === "failed") {
                await supabase
                  .from("jobs")
                  .update({ status: "failed", error_detail: "Reconciled from stale pg-boss job (failed)" })
                  .eq("id", job.id);
                continue;
              }
              console.warn(`[Poller] Job ${job.id} already exists in queue as "${state}" — skipping re-add`);
              continue;
            } else {
              console.warn(`[Poller] Job ${job.id} has retry_count>0 but not found in pg-boss — marking for manual review instead of blind resend`);
              await supabase.from("jobs").update({
                status: "needs_review",
                error_detail: "Job missing from pg-boss on reconcile; possibly already completed and archived",
              }).eq("id", job.id);
              continue;
            }
          }

          const nextRetryCount = (job.retry_count || 0) + 1;

          const { error: runErr } = await supabase
            .from("jobs")
            .update({
              status: "running",
              started_at: new Date().toISOString(),
              retry_count: nextRetryCount,
            })
            .eq("id", job.id)
            .eq("status", "pending");

          if (runErr) {
            console.error(`[Poller] Failed to update job ${job.id} to running:`, runErr);
            continue; // ✅ DB state uncertain — skip this cycle and retry later
          }

          // pg-boss: id lets us dedupe/reconcile by the same id as the
          // Supabase row (mirrors BullMQ's jobId option).
          await withTimeout(
            boss.send("compx-jobs", {
              id: job.id,
              type: job.type,
              user_id: job.user_id,
              billing_user_id: job.billing_user_id ?? job.user_id,
              input_data: job.input_data,
            }, {
              id: job.id,
              priority: job.priority,
              retryLimit: job.max_retries || 3,
              retryDelay: 5,
              retryBackoff: true,
            }),
            DB_CALL_TIMEOUT,
            `boss.send(${job.id})`
          );
        } catch (e) {
          if (isTransientInfraError(e)) {
            console.warn(`[Poller] Postgres/connection issue enqueueing job ${job.id}, will retry next cycle:`, e.message);
            await supabase
              .from("jobs")
              .update({ status: "pending", retry_count: job.retry_count || 0 })
              .eq("id", job.id)
              .eq("status", "running");
            continue;
          }

          console.warn(`[Poller] Failed to enqueue job ${job.id}:`, e.message);
          const nextRetryCount = (job.retry_count || 0) + 1;
          if (nextRetryCount >= 3) {
            await supabase
              .from("jobs")
              .update({
                status: "failed",
                retry_count: nextRetryCount,
                error_detail: `Poller failed to enqueue after ${nextRetryCount} attempts: ${e.message}`,
              })
              .eq("id", job.id);
          } else {
            await supabase
              .from("jobs")
              .update({ status: "pending", retry_count: nextRetryCount })
              .eq("id", job.id);
          }
        }
      }
    } catch (err) {
      console.error("[Poller] Poll error:", err.message);
    } finally {
      isPolling = false;
    }
  };

  // ── Supabase Realtime: instant trigger on new pending jobs ──────────────────
  // This eliminates the ~8s delay between job creation and processing.
  // The setInterval above is a safety-net for any missed realtime events.
  supabase
    .channel("jobs-pending-watcher")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "jobs", filter: "status=eq.pending" },
      (payload) => {
        console.log(`[Poller] 🔔 Realtime: new pending job ${payload.new?.id} — triggering immediate poll`);
        poll();
      }
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        console.log("[Poller] ✅ Realtime subscription active on jobs table");
      } else if (status === "CHANNEL_ERROR") {
        console.warn("[Poller] ⚠️ Realtime subscription failed — polling only mode");
      }
    });

  setInterval(poll, POLL_INTERVAL);
  poll();
  console.log(`[Poller] Started — polling every ${POLL_INTERVAL / 1000}s + Supabase Realtime`);
}
