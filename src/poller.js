/**
 * Polls Supabase jobs table and enqueues to BullMQ.
 * Fallback if Redis is unavailable or for initial job pickup.
 *
 * FIX (Redis/Upstash request reduction):
 *   - POLL_INTERVAL raised from 10s to 30s. This alone cuts Redis traffic
 *     from this poller by ~3x. 10s polling has no real benefit here — jobs
 *     aren't so time-sensitive that a 20s extra delay matters, but it was
 *     burning a large share of the Upstash monthly request quota.
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
 */

const POLL_INTERVAL = 30_000;
const BATCH_SIZE = 20;

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
            const existing = await queue.getJob(job.id);
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

          await queue.add(
            job.type,
            { id: job.id, type: job.type, user_id: job.user_id, input_data: job.input_data },
            {
              jobId: job.id,
              priority: job.priority,
              attempts: job.max_retries || 3,
              backoff: { type: "exponential", delay: 5000 },
            }
          );
        } catch (e) {
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
