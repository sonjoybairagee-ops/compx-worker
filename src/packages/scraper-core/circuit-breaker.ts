import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { sendSlackAlert } from "./alerting.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

export const CIRCUIT_BREAKER_CONFIG = {
  WINDOW_SIZE: 20,
  FAILURE_THRESHOLD: 0.8, // 80%
  OPEN_TIME_MS: 600_000,  // 10 minutes
  HALF_OPEN_MAX: 1,
  RETRY_COUNT: 3,
  BACKOFF: [1000, 2000, 5000],
};

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

let cachedClient: AnySupabase | null = null;
function getSupabase(): AnySupabase {
  if (cachedClient) return cachedClient;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  cachedClient = createClient(url, key, { realtime: { transport: ws as any } });
  return cachedClient;
}

/**
 * ✅ FIX: Uses Postgres Advisory Locks for atomic state transitions.
 * No Redis needed. Safe for high concurrency across multiple workers.
 */
export async function checkCircuitBreaker(provider: string): Promise<CircuitState> {
  try {
    const supabase = getSupabase();
    
    // Use advisory lock to make this entire operation atomic
    const { data: lockedData } = await supabase.rpc("try_advisory_lock", { 
      lock_id: hashProviderToNumber(provider) 
    });

    if (!lockedData) {
      // Another worker is currently modifying this provider's state, fail safe
      return "CLOSED";
    }

    try {
      const now = Date.now();
      
      // Fetch current state
      const { data: currentState } = await supabase
        .from("circuit_breaker_states")
        .select("*")
        .eq("provider", provider)
        .single();

      // If no record exists, initialize as CLOSED
      if (!currentState) {
        await supabase.from("circuit_breaker_states").insert({
          provider,
          state: "CLOSED",
          half_open_count: 0,
          window_data: [],
          updated_at: new Date().toISOString(),
        });
        return "CLOSED";
      }

      // Handle OPEN -> HALF_OPEN transition atomically
      if (currentState.state === "OPEN") {
        const openedAt = new Date(currentState.updated_at).getTime();
        if (now - openedAt >= CIRCUIT_BREAKER_CONFIG.OPEN_TIME_MS) {
          await supabase
            .from("circuit_breaker_states")
            .update({ 
              state: "HALF_OPEN", 
              half_open_count: 1,
              updated_at: new Date().toISOString() 
            })
            .eq("provider", provider);
          
          console.log(`[CircuitBreaker] ${provider} transitioning OPEN -> HALF_OPEN`);
          return "HALF_OPEN";
        }
        return "OPEN";
      }

      // Handle HALF_OPEN test request limiting
      if (currentState.state === "HALF_OPEN") {
        const currentCount = currentState.half_open_count || 0;
        if (currentCount >= CIRCUIT_BREAKER_CONFIG.HALF_OPEN_MAX) {
          return "OPEN"; // Deny additional test requests
        }
        
        // Atomically increment counter
        await supabase
          .from("circuit_breaker_states")
          .update({ 
            half_open_count: currentCount + 1,
            updated_at: new Date().toISOString() 
          })
          .eq("provider", provider);
          
        return "HALF_OPEN";
      }

      return "CLOSED";
    } finally {
      // Always release the advisory lock
      await supabase.rpc("release_advisory_lock", { 
        lock_id: hashProviderToNumber(provider) 
      });
    }
  } catch (err) {
    console.warn(`[CircuitBreaker] DB fail during check, failing safe (CLOSED):`, err);
    return "CLOSED";
  }
}

export async function recordFailure(provider: string) {
  try {
    const supabase = getSupabase();
    const now = Date.now();

    const { data: currentState } = await supabase
      .from("circuit_breaker_states")
      .select("*")
      .eq("provider", provider)
      .single();

    if (!currentState) return;

    // If in HALF_OPEN and test fails, trip immediately
    if (currentState.state === "HALF_OPEN") {
      console.log(`[CircuitBreaker] ${provider} test failed, tripping to OPEN`);
      await tripCircuit(provider, "Failed during HALF_OPEN state");
      return;
    }

    // Update sliding window using JSONB array
    const currentWindow: string[] = Array.isArray(currentState.window_data) ? currentState.window_data : [];
    currentWindow.unshift("0"); // 0 = failure
    if (currentWindow.length > CIRCUIT_BREAKER_CONFIG.WINDOW_SIZE) {
      currentWindow.splice(CIRCUIT_BREAKER_CONFIG.WINDOW_SIZE);
    }

    // Check failure threshold
    if (currentWindow.length >= 10) {
      const failures = currentWindow.filter(v => v === "0").length;
      const failurePercent = failures / currentWindow.length;

      if (failurePercent >= CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD) {
        console.log(`[CircuitBreaker] ${provider} threshold crossed: ${failures}/${currentWindow.length}`);
        await tripCircuit(provider, `${failures} failures in last ${currentWindow.length} requests`);
        return;
      }
    }

    // Save updated window
    await supabase
      .from("circuit_breaker_states")
      .update({ 
        window_data: currentWindow,
        updated_at: new Date().toISOString() 
      })
      .eq("provider", provider);

  } catch (err) {
    console.warn(`[CircuitBreaker] Failed to record failure:`, err);
  }
}

export async function recordSuccess(provider: string) {
  try {
    const supabase = getSupabase();

    const { data: currentState } = await supabase
      .from("circuit_breaker_states")
      .select("*")
      .eq("provider", provider)
      .single();

    if (!currentState) return;

    // Recover from HALF_OPEN
    if (currentState.state === "HALF_OPEN") {
      console.log(`[CircuitBreaker] ${provider} test succeeded, recovering...`);
      await supabase
        .from("circuit_breaker_states")
        .update({ 
          state: "CLOSED", 
          window_data: [],
          half_open_count: 0,
          updated_at: new Date().toISOString() 
        })
        .eq("provider", provider);
      
      await sendSlackAlert(provider, "CLOSED", "Recovery complete. Service is healthy.");
      return;
    }

    // Add success to sliding window
    const currentWindow: string[] = Array.isArray(currentState.window_data) ? currentState.window_data : [];
    currentWindow.unshift("1"); // 1 = success
    if (currentWindow.length > CIRCUIT_BREAKER_CONFIG.WINDOW_SIZE) {
      currentWindow.splice(CIRCUIT_BREAKER_CONFIG.WINDOW_SIZE);
    }

    await supabase
      .from("circuit_breaker_states")
      .update({ 
        window_data: currentWindow,
        updated_at: new Date().toISOString() 
      })
      .eq("provider", provider);

  } catch (err) {
    console.warn(`[CircuitBreaker] Failed to record success:`, err);
  }
}

async function tripCircuit(provider: string, reason: string) {
  const supabase = getSupabase();
  
  await supabase
    .from("circuit_breaker_states")
    .update({ 
      state: "OPEN",
      window_data: [],
      half_open_count: 0,
      updated_at: new Date().toISOString() 
    })
    .eq("provider", provider);

  console.log(`[CircuitBreaker] ${provider} tripped to OPEN: ${reason}`);
  await sendSlackAlert(provider, "OPEN", reason);
}

/**
 * Hashes provider name to a number for Postgres Advisory Locks.
 * Advisory locks require bigint IDs.
 */
function hashProviderToNumber(provider: string): number {
  let hash = 0;
  for (let i = 0; i < provider.length; i++) {
    const char = provider.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}