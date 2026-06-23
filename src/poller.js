/**
 * CompX Worker — src/poller.js
 * Polls Supabase jobs table and enqueues to BullMQ
 * Fallback if Redis is unavailable or for initial job pickup
 */

const POLL_INTERVAL = 10_000; // 10 seconds
const BATCH_SIZE    = 20;

export function pollSupabaseJobs(queue, supabase) {
  let isPolling = false;

  const poll = async () => {
    if (isPolling) return;
    isPolling = true;

    try {
      // Fetch pending jobs ordered by priority + created_at
      const { data: jobs, error } = await supabase
        .from("jobs")
        .select("*")
        .eq("status", "pending")
        .lt("retry_count", 3)
        .order("priority",   { ascending: true })
        .order("created_at", { ascending: true })
        .limit(BATCH_SIZE);

      if (error) throw error;
      if (!jobs?.length) return;

      console.log(`[Poller] Found ${jobs.length} pending jobs`);

      for (const job of jobs) {
        try {
          // Mark as running to prevent double-pickup
          await supabase
            .from("jobs")
            .update({ status: "running", started_at: new Date().toISOString() })
            .eq("id", job.id)
            .eq("status", "pending"); // optimistic lock

          // Enqueue to BullMQ
          await queue.add(
            job.type,
            {
              id:         job.id,
              type:       job.type,
              user_id:    job.user_id,
              input_data: job.input_data,
            },
            {
              jobId:    job.id,
              priority: job.priority,
              attempts: job.max_retries || 3,
              backoff:  { type: "exponential", delay: 5000 },
            }
          );
        } catch (e) {
          console.warn(`[Poller] Failed to enqueue job ${job.id}:`, e.message);
          // Reset to pending if enqueue failed
          await supabase
            .from("jobs")
            .update({ status: "pending" })
            .eq("id", job.id);
        }
      }
    } catch (err) {
      console.error("[Poller] Poll error:", err.message);
    } finally {
      isPolling = false;
    }
  };

  // Start polling
  setInterval(poll, POLL_INTERVAL);
  poll(); // immediate first run
  console.log(`[Poller] Started — polling every ${POLL_INTERVAL / 1000}s`);
}

