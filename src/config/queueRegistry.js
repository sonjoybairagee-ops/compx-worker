import { Queue } from "bullmq";
import { redisConnection } from "./redisConnection.js";

export const QUEUE_NAMES = {
  COMPX_JOBS: "compx-jobs",
  DRIP_JOBS: "drip-jobs",
  AI_ENRICHMENT: "ai-enrichment", // NEW — Phase 14
  DLQ_COMPX_JOBS: "dlq-compx-jobs",
  DLQ_DRIP_JOBS: "dlq-drip-jobs",
};

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 1000 },
};

const dlqJobOptions = {
  attempts: 1,
  removeOnComplete: false,
  removeOnFail: false,
};

const queues = new Map();

function getOrCreate(name, options = {}) {
  if (!queues.has(name)) {
    queues.set(name, new Queue(name, { connection: redisConnection, defaultJobOptions: options }));
  }
  return queues.get(name);
}

export const compxJobsQueue = () => getOrCreate(QUEUE_NAMES.COMPX_JOBS, defaultJobOptions);
export const dripQueue = () => getOrCreate(QUEUE_NAMES.DRIP_JOBS, { ...defaultJobOptions, attempts: 5 });
export const aiEnrichmentQueue = () => getOrCreate(QUEUE_NAMES.AI_ENRICHMENT, defaultJobOptions);
export const dlqCompxQueue = () => getOrCreate(QUEUE_NAMES.DLQ_COMPX_JOBS, dlqJobOptions);
export const dlqDripQueue = () => getOrCreate(QUEUE_NAMES.DLQ_DRIP_JOBS, dlqJobOptions);

export const DLQ_MAP = {
  [QUEUE_NAMES.COMPX_JOBS]: dlqCompxQueue,
  [QUEUE_NAMES.DRIP_JOBS]: dlqDripQueue,
};

export function getAllQueues() {
  compxJobsQueue();
  dripQueue();
  aiEnrichmentQueue();
  dlqCompxQueue();
  dlqDripQueue();
  return Array.from(queues.values());
}

export async function closeAllQueues() {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
  console.log("[QueueRegistry] All queues closed.");
}
