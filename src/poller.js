/**
 * Polls Supabase jobs table and enqueues to BullMQ.
 * Fallback if Redis is unavailable or for initial job pickup.
 *
 * FIX (Redis/Upstash request reduction):
 *   - POLL_INTERVAL raised from 10s to 60s to minimize Upstash request-quota
 *     cost. Jobs aren't so time-sensitive that an extra delay matters, but
 *     10s polling was burning a large share of the monthly request quota.
 *   - queue.getJob(job.id) — a Redis call — used to run for EVERY pending
 *     row on EVERY poll cycle, even brand-new jobs (retry_count = 0) that
 *     could not possibly already exist in BullMQ yet (the poller is the
 *     only thing that ever adds them). That call is now skipped for
 *     retry_count === 0 rows and only made for rows that have already been
 *     attempted at least once, which is the only case where a stale BullMQ
 *     job could actually exist. This removes the single biggest source of
 *     redundant Redis calls without changing behavior for the reconcile
 *     path (failed/completed BullMQ jobs are still detected and reconciled
 *     the same way as before).
 *
 * FIX (transient Redis outages were permanently failing good jobs):
 *   - Previously ANY error from queue.getJob()/queue.add() — including a
 *     dropped/closed Redis connection — incremented retry_count the same
 *     as a genuine job error, and marked the row "failed" once
 *     retry_count hit 3. Since this poller only runs every 60s, a Redis
 *     outage lasting ~3 minutes (e.g. the shared connection being closed
 *     during a worker restart) was enough to permanently fail every
 *     pending job in that window, even though nothing was wrong with the
 *     jobs themselves. Redis/connection errors are now detected
 *     separately: the row is left untouched (still "pending", retry_count
 *     unchanged) so the next poll cycle simply tries again once the
 *     connection recovers. Only genuine per-job errors (bad data, Supabase
 *     write failures, etc.) still count toward retry_count/failure.
 *   - queue.getJob()/queue.add() are also now wrapped with a timeout. The
 *     shared ioredis client uses maxRetriesPerRequest: null (retry
 *     forever), which is correct for the worker but means a call from
 *     here could hang indefinitely during a reconnect storm — with no
 *     timeout, isPolling would stay true forever and this poller would
 *     silently stop working until the process was restarted.
 */

const POLL_INTERVAL = 60_000;
const BATCH_SIZE = 10;
const REDIS_CALL_TIMEOUT = 10_000;

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

// Distinguishes "Redis/connection is having a bad time" from "this specific
// job is broken". Only the latter should ever count toward retry_count or
// mark a row failed.
function isTransientInfraError(e) {
  const msg = String(e?.message || e || "");
  return (
    msg.includes("Connection is closed") ||
    msg.includes("timed out") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("Command timed out") ||
    e?.name === "MaxRetriesPerRequestError"
  );
}

export function pollSupabaseJobs(queue, supabase) {
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
          // FIX: only ask Redis whether this job already exists in BullMQ
          // if it has been attempted before. A fresh job (retry_count === 0)
          // has never been added to the queue by anything other than this
          // poller, so there is nothing to reconcile — skip the Redis call
          // entirely and go straight to adding it.
          if ((job.retry_count || 0) > 0) {
            // ✅ FIX: if a BullMQ job with this same ID already exists (e.g. it
            // already completed but the Supabase row update didn't stick),
            // don't re-add it — that silently no-ops in BullMQ and leaves the
            // Supabase row stuck on "pending" forever. Reconcile instead.
            const existing = await withTimeout(queue.getJob(job.id), REDIS_CALL_TIMEOUT, `getJob(${job.id})`);
            if (existing) {
              const state = await existing.getState();
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
                  .update({ status: "failed", error_detail: "Reconciled from stale BullMQ job (failed)" })
                  .eq("id", job.id);
                continue;
              }
              console.warn(`[Poller] Job ${job.id} already exists in queue as "${state}" — skipping re-add`);
              continue;
            }
          }

          const nextRetryCount = (job.retry_count || 0) + 1;

          const { error: runErr } = await supabase
            .from("jobs")
            .update({
              status: "running",
              started_at: new Date().toISOString(),
              retry_count: nextRetryCount, // ✅ FIX: increment so it can't loop forever
            })
            .eq("id", job.id)
            .eq("status", "pending");
          
          if (runErr) {
            console.error(`[Poller] Failed to update job ${job.id} to running:`, runErr);
          }

          await withTimeout(
            queue.add(
              job.type,
              { id: job.id, type: job.type, user_id: job.user_id, input_data: job.input_data },
              {
                jobId: job.id,
                priority: job.priority,
                attempts: job.max_retries || 3,
                backoff: { type: "exponential", delay: 5000 },
              }
            ),
            REDIS_CALL_TIMEOUT,
            `queue.add(${job.id})`
          );
        } catch (e) {
          if (isTransientInfraError(e)) {
            // Redis/connection hiccup — not the job's fault. The row was
            // already flipped to "running" (and retry_count bumped) right
            // before queue.add() above; if queue.add() itself is what
            // failed, that row would otherwise be stuck as "running"
            // forever since the poller only ever selects status="pending".
            // Revert both so the next 60s cycle picks it back up as a
            // fresh attempt once the connection recovers, without burning
            // a retry on infra flakiness.
            console.warn(`[Poller] Redis/connection issue enqueueing job ${job.id}, will retry next cycle:`, e.message);
            await supabase
              .from("jobs")
              .update({ status: "pending", retry_count: job.retry_count || 0 })
              .eq("id", job.id)
              .eq("status", "running");
            continue;
          }

          console.warn(`[Poller] Failed to enqueue job ${job.id}:`, e.message);
          // ✅ FIX: also increment retry_count here, and stop resetting to "pending"
          // once retries are exhausted — mark as failed instead so it can't loop forever.
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

  setInterval(poll, POLL_INTERVAL);
  poll();
  console.log(`[Poller] Started — polling every ${POLL_INTERVAL / 1000}s`);
}
