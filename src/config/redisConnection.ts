import { ConnectionOptions } from "bullmq";

// ─── Redis Connection (BullMQ-এর জন্য) ───────────────────────────────────────
// Upstash Redis ব্যবহার করলে: UPSTASH_REDIS_URL এবং UPSTASH_REDIS_TOKEN দিন
// Self-hosted Redis হলে: REDIS_URL দিন

function createRedisConnection(): ConnectionOptions {
  const redisUrl = process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL;

  if (!redisUrl) {
    throw new Error(
      "❌ REDIS_URL বা UPSTASH_REDIS_URL environment variable সেট করা নেই!"
    );
  }

  // Upstash TLS URL parse করা
  if (redisUrl.startsWith("rediss://") || redisUrl.startsWith("redis://")) {
    const url = new URL(redisUrl);
    return {
      host: url.hostname,
      port: parseInt(url.port || "6379"),
      password: url.password || undefined,
      tls: redisUrl.startsWith("rediss://") ? {} : undefined,
      maxRetriesPerRequest: null, // BullMQ-এর জন্য এটা null রাখা জরুরি
      enableReadyCheck: false,
    };
  }

  throw new Error(`❌ Invalid REDIS_URL format: ${redisUrl}`);
}

export const redisConnection = createRedisConnection();
