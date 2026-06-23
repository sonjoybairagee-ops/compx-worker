/**
 * src/config/redisConnection.js
 * TypeScript → JavaScript + silent failure fix
 */

import IORedis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

export const redisConnection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck:     false,
  tls: REDIS_URL.startsWith("rediss://") ? { rejectUnauthorized: false } : undefined,
  retryStrategy: (times) => {
    if (times > 5) {
      console.error("[Redis] ❌ Failed after 5 retries — shutting down");
      process.exit(1);
    }
    const delay = Math.min(times * 500, 3000);
    console.warn(`[Redis] Reconnecting in ${delay}ms (attempt ${times}/5)...`);
    return delay;
  },
});

redisConnection.on("connect", () => console.log("[Redis] ✅ Connected"));
redisConnection.on("error",   (e) => console.error("[Redis] Error:", e.message));

export default redisConnection;
