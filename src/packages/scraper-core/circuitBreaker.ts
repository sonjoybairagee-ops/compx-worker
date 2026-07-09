// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Redis = any; // Avoid cross-package ioredis version conflict
import { sendSlackAlert } from "./alerting.js";

export const CIRCUIT_BREAKER_CONFIG = {
  WINDOW_SIZE: 20,
  FAILURE_THRESHOLD: 0.8, // 80%
  OPEN_TIME_MS: 600000,   // 10 minutes
  HALF_OPEN_MAX: 1,
  RETRY_COUNT: 2,
  BACKOFF: [1000, 2000],
  JITTER_MS: 60000,
};

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export async function checkCircuitBreaker(provider: string, redis: Redis): Promise<CircuitState> {
  if (!redis) return "CLOSED";
  
  try {
    const stateKey = `cb:provider:${provider}:state`;
    const lockKey = `cb:provider:${provider}:lock`;
    const state = await redis.get(stateKey);
    const lock = await redis.get(lockKey);

    if (state === "OPEN") {
      if (!lock) {
        // The 10-minute cooldown has expired, transition to HALF_OPEN
        await redis.set(stateKey, "HALF_OPEN");
        console.log(`[CircuitBreaker] ${provider} transitioning OPEN -> HALF_OPEN`);
        
        // Setup HALF_OPEN counter to allow exactly ONE test request
        const halfOpenKey = `cb:provider:${provider}:half_open_count`;
        await redis.del(halfOpenKey);
        await redis.incr(halfOpenKey); // Count = 1
        
        return "HALF_OPEN";
      }
      return "OPEN";
    }

    if (state === "HALF_OPEN") {
      const halfOpenKey = `cb:provider:${provider}:half_open_count`;
      const count = await redis.incr(halfOpenKey);
      if (count > CIRCUIT_BREAKER_CONFIG.HALF_OPEN_MAX) {
        return "OPEN"; // Deny other jobs until the test request resolves
      }
      return "HALF_OPEN";
    }

    // Default is CLOSED
    return "CLOSED";
  } catch (err) {
    console.warn(`[CircuitBreaker] Redis fail during check, failing OPEN (allowing traffic):`, err);
    return "CLOSED";
  }
}

export async function recordFailure(provider: string, redis: Redis) {
  if (!redis) return;
  
  try {
    const stateKey = `cb:provider:${provider}:state`;
    const windowKey = `cb:provider:${provider}:window`;

    const state = await redis.get(stateKey);
    
    if (state === "HALF_OPEN") {
      console.log(`[CircuitBreaker] ${provider} test request failed, transitioning HALF_OPEN -> OPEN`);
      await tripCircuit(provider, redis, "Failed during HALF_OPEN state");
      return;
    }

    // Add failure (0 = fail) to the window
    await redis.lpush(windowKey, "0");
    await redis.ltrim(windowKey, 0, CIRCUIT_BREAKER_CONFIG.WINDOW_SIZE - 1);

    // Check sliding window failure rate
    const window = await redis.lrange(windowKey, 0, -1);
    if (window.length >= 10) { 
      const failures = window.filter(val => val === "0").length;
      const failurePercent = failures / window.length;

      if (failurePercent >= CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD) {
        console.log(`[CircuitBreaker] ${provider} failure threshold crossed: ${failures}/${window.length} (${(failurePercent*100).toFixed(0)}%)`);
        await tripCircuit(provider, redis, `${failures} failures in last ${window.length} requests (${(failurePercent*100).toFixed(0)}%)`);
      }
    }
  } catch (err) {
    console.warn(`[CircuitBreaker] Failed to record failure:`, err);
  }
}

export async function recordSuccess(provider: string, redis: Redis) {
  if (!redis) return;
  
  try {
    const stateKey = `cb:provider:${provider}:state`;
    const windowKey = `cb:provider:${provider}:window`;

    const state = await redis.get(stateKey);
    if (state === "HALF_OPEN") {
      console.log(`[CircuitBreaker] ${provider} test request succeeded, transitioning HALF_OPEN -> CLOSED`);
      await redis.set(stateKey, "CLOSED");
      await redis.del(windowKey); // Reset window
      await sendSlackAlert(provider, "CLOSED", "Recovery complete. Service is healthy.", redis);
      return;
    }

    // Add success (1 = success) to the window
    await redis.lpush(windowKey, "1");
    await redis.ltrim(windowKey, 0, CIRCUIT_BREAKER_CONFIG.WINDOW_SIZE - 1);
  } catch (err) {
    console.warn(`[CircuitBreaker] Failed to record success:`, err);
  }
}

async function tripCircuit(provider: string, redis: Redis, reason: string) {
  const stateKey = `cb:provider:${provider}:state`;
  const lockKey = `cb:provider:${provider}:lock`;
  const halfOpenKey = `cb:provider:${provider}:half_open_count`;
  
  await redis.set(stateKey, "OPEN");
  await redis.set(lockKey, "1", "PX", CIRCUIT_BREAKER_CONFIG.OPEN_TIME_MS);
  await redis.del(halfOpenKey);
  
  console.log(`[CircuitBreaker] ${provider} transitioning to OPEN`);
  await sendSlackAlert(provider, "OPEN", reason, redis);
}
