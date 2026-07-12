import { Queue } from "bullmq";
import { redisConnection } from "./redisConnection.js";

export const QUEUE_NAMES = {
  COMPX_JOBS: "compx-jobs",
  LEAD_ENRICHMENT: "lead_enrichment", // NEW — was created ad-hoc in index.js without cleanup options
  AI_ENRICHMENT: "ai-enrichment", // NEW — Phase 14
  DLQ_COMPX_JOBS: "dlq-compx-jobs",
};

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: { count: 20 },
  removeOnFail: { count: 50 },
};

const dlqJobOptions = {
  attempts: 1,
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 200 },
};

const queues = new Map();

function getOrCreate(name, options = {}) {
  if (!queues.has(name)) {
    queues.set(name, new Queue(name, { connection: redisConnection, defaultJobOptions: options }));
  }
  return queues.get(name);
}

export const compxJobsQueue = () => getOrCreate(QUEUE_NAMES.COMPX_JOBS, defaultJobOptions);
export const leadEnrichmentQueue = () => getOrCreate(QUEUE_NAMES.LEAD_ENRICHMENT, defaultJobOptions);
export const aiEnrichmentQueue = () => getOrCreate(QUEUE_NAMES.AI_ENRICHMENT, defaultJobOptions);
export const dlqCompxQueue = () => getOrCreate(QUEUE_NAMES.DLQ_COMPX_JOBS, dlqJobOptions);

export const DLQ_MAP = {
  [QUEUE_NAMES.COMPX_JOBS]: dlqCompxQueue,
};

export function getAllQueues() {
  compxJobsQueue();
  leadEnrichmentQueue();
  aiEnrichmentQueue();
  dlqCompxQueue();
  return Array.from(queues.values());
}

export async function closeAllQueues() {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
  console.log("[QueueRegistry] All queues closed.");
}