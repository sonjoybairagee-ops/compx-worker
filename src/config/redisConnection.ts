/**
 * worker/src/config/redisConnection.ts
 * Redis connection singleton for BullMQ
 */

import IORedis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

export const redisConnection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck:     false,
  tls: REDIS_URL.startsWith("rediss://") ? {
    rejectUnauthorized: false,
  } : undefined,
  retryStrategy: (times) => {
    if (times > 5) return null;
    return Math.min(times * 500, 3000);
  },
});

redisConnection.on("connect", () => console.log("[Redis] Connected"));
redisConnection.on("error",   (e) => console.error("[Redis] Error:", e.message));

export default redisConnection;
