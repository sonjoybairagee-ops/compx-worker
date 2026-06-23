/**
 * src/config/dlqHandler.js
 * TypeScript → JavaScript converted
 */

import { UnrecoverableError, Queue } from "bullmq";
import { redisConnection } from "./redisConnection.js";
import { DLQ_MAP } from "./queueRegistry.js";

export function attachDLQListener(worker, queueName) {
  worker.on("failed", async (job, error) => {
    if (!job) return;

    const maxAttempts = job.opts.attempts ?? 3;
    const isExhausted = job.attemptsMade >= maxAttempts;

    if (!isExhausted) {
      console.warn(`[DLQ] Job "${job.name}" (${job.id}) retry ${job.attemptsMade}/${maxAttempts} — queue: ${queueName}`);
      return;
    }

    console.error(`[DLQ] ☠️  Job "${job.name}" (${job.id}) exhausted retries → dlq-${queueName}`);

    const dlqQueueFactory = DLQ_MAP[queueName];
    if (!dlqQueueFactory) {
      console.error(`[DLQ] No DLQ found for queue: ${queueName}`);
      return;
    }

    const dlqQueue = dlqQueueFactory();
    const dlqPayload = {
      originalQueue:   queueName,
      originalJobId:   job.id ?? "unknown",
      originalJobName: job.name,
      originalData:    job.data,
      failedReason:    error.message,
      failedAt:        new Date().toISOString(),
      attemptsMade:    job.attemptsMade,
      stacktrace:      job.stacktrace ?? [],
    };

    try {
      await dlqQueue.add(`dlq:${job.name}`, dlqPayload, { priority: 1 });
      console.log(`[DLQ] ✅ Job moved to DLQ`);
    } catch (dlqError) {
      console.error(`[DLQ] ❌ Failed to move to DLQ:`, dlqError);
    }
  });
}

export function throwUnrecoverable(message) {
  throw new UnrecoverableError(message);
}

export async function retryFromDLQ(dlqJobId, originalQueueName) {
  const dlqName  = `dlq-${originalQueueName}`;
  const dlqQueue = new Queue(dlqName, { connection: redisConnection });
  const job      = await dlqQueue.getJob(dlqJobId);

  if (!job) throw new Error(`DLQ job ${dlqJobId} not found in ${dlqName}`);

  const originalQueue = new Queue(originalQueueName, { connection: redisConnection });
  await originalQueue.add(job.data.originalJobName, job.data.originalData, {
    attempts: 3,
    backoff:  { type: "exponential", delay: 2000 },
  });

  await job.remove();
  console.log(`[DLQ] 🔄 Job ${dlqJobId} retried → ${originalQueueName}`);
}
