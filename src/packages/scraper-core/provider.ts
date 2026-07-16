/**
 * scraper-core/provider.ts
 *
 * The formal Provider abstraction referenced across the plugin refactor.
 * Now fully adapted for Supabase-only architecture (No Redis).
 */

import { checkCircuitBreaker, recordFailure, recordSuccess } from "./circuit-breaker.js";
import { recordProviderMetric } from "./metrics.js";
import { ProviderError, ProviderErrorType } from "./errors.js";

export interface ProviderRunContext {
  jobId: string;
  logger: { log: (msg: string) => Promise<void> | void };
  // ✅ FIX: Removed redis?: any; Supabase client is now passed via metrics/circuit-breaker internally
  [key: string]: any;
}

/**
 * Every vendor integration implements this. `name` is the key used for 
 * circuit-breaker state AND capability-registry ordering.
 */
export interface SourceProvider<TInput = any, TRaw = any> {
  name: string;
  fetch(input: TInput, ctx: ProviderRunContext): Promise<TRaw[]>;
}

export interface ProviderRouterOptions {
  /** Capability key used purely for logging (e.g. "google_maps", "linkedin"). */
  capability: string;
}

/**
 * Tries providers in order with Circuit Breaker checks and fallback logic.
 * Fully compatible with Supabase-based state management.
 */
export class ProviderRouter<TInput = any, TRaw = any> {
  private providers: SourceProvider<TInput, TRaw>[];
  private capability: string;

  constructor(providers: SourceProvider<TInput, TRaw>[], opts: ProviderRouterOptions) {
    if (providers.length === 0) {
      throw new Error(`ProviderRouter for "${opts.capability}" was constructed with zero providers`);
    }
    this.providers = providers;
    this.capability = opts.capability;
  }

  async fetch(input: TInput, ctx: ProviderRunContext): Promise<{ data: TRaw[]; provider: string }> {
    let lastError: any = null;

    for (const provider of this.providers) {
      // ✅ FIX: No longer passes ctx.redis to circuit breaker
      const cbState = await checkCircuitBreaker(provider.name);
      
      if (cbState === "OPEN") {
        await ctx.logger.log(`[${this.capability}] Provider "${provider.name}" circuit is OPEN, skipping.`);
        continue;
      }

      const startedAt = Date.now();
      try {
        const data = await provider.fetch(input, ctx);
        const latencyMs = Date.now() - startedAt;

        // ✅ FIX: Record success without Redis dependency
        await recordSuccess(provider.name);
        await recordProviderMetric(provider.name, { success: true, latencyMs });

        return { data, provider: provider.name };
      } catch (err: any) {
        const latencyMs = Date.now() - startedAt;
        lastError = err;

        // ✅ FIX: Record failure without Redis dependency
        await recordFailure(provider.name);
        await recordProviderMetric(provider.name, { success: false, latencyMs });

        const isLastProvider = this.providers.indexOf(provider) === this.providers.length - 1;
        await ctx.logger.log(
          `[${this.capability}] Provider "${provider.name}" failed: ${err?.message || err}. ` +
            (isLastProvider ? "No providers left." : "Trying next provider...")
        );
      }
    }

    if (lastError instanceof ProviderError) throw lastError;
    
    throw new ProviderError(
      ProviderErrorType.UNKNOWN,
      lastError?.message
        ? `All providers for "${this.capability}" failed. Last error: ${lastError.message}`
        : `All providers for "${this.capability}" are unavailable (circuit open).`
    );
  }
}