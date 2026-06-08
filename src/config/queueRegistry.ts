import { Queue, QueueOptions } from "bullmq";
import { redisConnection } from "./redisConnection";

// ─── Queue Names (single source of truth) ────────────────────────────────────
export const QUEUE_NAMES = {
  COMPX_JOBS: "compx-jobs",           // আপনার main queue
  DLQ_COMPX_JOBS: "dlq-compx-jobs",   // DLQ
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// ─── Shared Queue Defaults ────────────────────────────────────────────────────
const defaultQueueOptions: QueueOptions = {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential", // 2s → 4s → 8s
      delay: 2000,
    },
    removeOnComplete: { count: 500 },   // শুধু শেষ ৫০০টি completed job রাখো
    removeOnFail: { count: 1000 },      // শুধু শেষ ১০০০টি failed job রাখো
  },
};

// ─── DLQ Options (no retry — এখানে এলে manual review দরকার) ─────────────────
const dlqOptions: QueueOptions = {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: false, // DLQ-তে সব রাখো — manually clean করতে হবে
    removeOnFail: false,
  },
};

// ─── Queue Instances ──────────────────────────────────────────────────────────
// Singleton pattern — একই Queue instance বারবার তৈরি হবে না
const queues = new Map<string, Queue>();

function getOrCreateQueue(name: string, options: QueueOptions): Queue {
  if (!queues.has(name)) {
    queues.set(name, new Queue(name, options));
  }
  return queues.get(name)!;
}

// Main Queues
export const compxJobsQueue = () =>
  getOrCreateQueue(QUEUE_NAMES.COMPX_JOBS, defaultQueueOptions);

// Dead Letter Queues
export const dlqCompxJobsQueue = () =>
  getOrCreateQueue(QUEUE_NAMES.DLQ_COMPX_JOBS, dlqOptions);

// ─── Helper: DLQ mapping ──────────────────────────────────────────────────────
export const DLQ_MAP: Record<string, () => Queue> = {
  [QUEUE_NAMES.COMPX_JOBS]: dlqCompxJobsQueue,
};

// ─── getAllQueues: Bull-Board এর জন্য সব queues এর list ──────────────────────
export function getAllQueues(): Queue[] {
  // Ensure all queues are initialized
  compxJobsQueue();
  dlqCompxJobsQueue();

  return Array.from(queues.values());
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
export async function closeAllQueues(): Promise<void> {
  const closePromises = Array.from(queues.values()).map((q) => q.close());
  await Promise.all(closePromises);
  queues.clear();
  console.log("[QueueRegistry] All queues closed.");
}
