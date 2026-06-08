import { Worker, Job, UnrecoverableError } from "bullmq";
import { redisConnection } from "./redisConnection";
import { DLQ_MAP, QUEUE_NAMES } from "./queueRegistry";

// ─── DLQ Job Payload ──────────────────────────────────────────────────────────
interface DLQJobData {
  originalQueue: string;
  originalJobId: string;
  originalJobName: string;
  originalData: unknown;
  failedReason: string;
  failedAt: string;
  attemptsMade: number;
  stacktrace?: string[];
}

// ─── DLQ Event Listener ───────────────────────────────────────────────────────
// প্রতিটি main queue-এর Worker-এ এই listener attach করুন।
// যখন কোনো job সব retries শেষ করে failed হবে, সেটি DLQ-তে যাবে।

export function attachDLQListener(worker: Worker, queueName: string): void {
  worker.on("failed", async (job: Job | undefined, error: Error) => {
    if (!job) return;

    const maxAttempts = job.opts.attempts ?? 3;
    const isExhausted = job.attemptsMade >= maxAttempts;

    // শুধু সব retry শেষ হলেই DLQ-তে পাঠাও
    if (!isExhausted) {
      console.warn(
        `[DLQ] Job "${job.name}" (${job.id}) retry ${job.attemptsMade}/${maxAttempts} — queue: ${queueName}`
      );
      return;
    }

    console.error(
      `[DLQ] ☠️  Job "${job.name}" (${job.id}) exhausted all retries. Moving to DLQ: dlq-${queueName}`
    );

    const dlqQueueFactory = DLQ_MAP[queueName];
    if (!dlqQueueFactory) {
      console.error(`[DLQ] No DLQ found for queue: ${queueName}`);
      return;
    }

    const dlqQueue = dlqQueueFactory();

    const dlqPayload: DLQJobData = {
      originalQueue: queueName,
      originalJobId: job.id ?? "unknown",
      originalJobName: job.name,
      originalData: job.data,
      failedReason: error.message,
      failedAt: new Date().toISOString(),
      attemptsMade: job.attemptsMade,
      stacktrace: job.stacktrace ?? [],
    };

    try {
      await dlqQueue.add(`dlq:${job.name}`, dlqPayload, {
        // DLQ jobs priority দিয়ে sort করা যাবে
        priority: 1,
      });
      console.log(`[DLQ] ✅ Job moved to DLQ successfully.`);
    } catch (dlqError) {
      console.error(`[DLQ] ❌ Failed to move job to DLQ:`, dlqError);
    }
  });
}

// ─── UnrecoverableError Helper ────────────────────────────────────────────────
// Worker-এর ভেতরে এই error throw করলে job সাথে সাথে DLQ-তে যাবে,
// আর কোনো retry হবে না। যেমন: invalid data, auth failure ইত্যাদি।

export function throwUnrecoverable(message: string): never {
  throw new UnrecoverableError(message);
}

// ─── DLQ Retry Helper ─────────────────────────────────────────────────────────
// Admin manually DLQ থেকে job original queue-তে ফিরিয়ে দিতে পারবে।

export async function retryFromDLQ(
  dlqJobId: string,
  originalQueueName: string
): Promise<void> {
  const { Queue } = await import("bullmq");
  const dlqName = `dlq-${originalQueueName}`;

  const dlqQueue = new Queue(dlqName, { connection: redisConnection });
  const job = await dlqQueue.getJob(dlqJobId);

  if (!job) {
    throw new Error(`DLQ job ${dlqJobId} not found in ${dlqName}`);
  }

  const originalData = (job.data as DLQJobData).originalData;
  const originalJobName = (job.data as DLQJobData).originalJobName;

  // Original queue-এ নতুন করে add করো
  const originalQueue = new Queue(originalQueueName, {
    connection: redisConnection,
  });

  await originalQueue.add(originalJobName, originalData, {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
  });

  // DLQ থেকে সরিয়ে দাও
  await job.remove();

  console.log(
    `[DLQ] 🔄 Job ${dlqJobId} retried from DLQ → ${originalQueueName}`
  );
}
