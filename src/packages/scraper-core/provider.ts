/**
 * scraper-core/provider.ts
 *
 * The formal Provider abstraction referenced across the plugin refactor.
 *
 * Problem this solves: before this file existed, each plugin called its
 * vendor's fetch function directly from index.ts (e.g. google-maps/index.ts
 * called fetchFromSerper() inline). Swapping a vendor meant editing the
 * plugin's orchestration file, and there was no shared place to record
 * per-vendor health/metrics or to fail over to a second vendor.
 *
 * Now: a plugin depends only on `SourceProvider<TInput, TRaw>` and asks a
 * `ProviderRouter` for data. The router owns circuit-breaker checks,
 * fallback order, retries-at-the-routing-level (distinct from a provider's
 * own internal retry/backoff), and metrics. The plugin's index.ts never
 * imports a vendor SDK or vendor-specific fetch function directly.
 */

import { checkCircuitBreaker, recordFailure, recordSuccess } from "./circuitBreaker.js";
import { recordProviderMetric } from "./metrics.js";
import { ProviderError, ProviderErrorType } from "./errors.js";

export interface ProviderRunContext {
  jobId: string;
  logger: { log: (msg: string) => Promise<void> | void };
  redis?: any;
  [key: string]: any;
}

/**
 * Every vendor integration (SerpApi, Serper, Apify, an in-house scraper,
 * a future Google Places API client, etc.) implements this. `name` is the
 * key used for circuit-breaker state AND for capability-registry ordering,
 * so it must be unique and stable — do not rename a provider once it has
 * live circuit-breaker history in Redis.
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
 * Tries providers in order. A provider is skipped if its circuit breaker is
 * OPEN. On failure (thrown error) or an OPEN circuit, the router moves to
 * the next provider in the list. If every provider fails/is-open, the last
 * error is re-thrown so the plugin's existing top-level error handling
 * (logger.log + DLQ) keeps working unchanged.
 *
 * For a single-provider plugin (most of them, today) this is a thin,
 * zero-overhead pass-through — but the plugin's index.ts already talks to
 * the router, not the vendor, so adding a second provider later is a
 * one-line change to the capability registry, not a plugin rewrite.
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
      const cbState = await checkCircuitBreaker(provider.name, ctx.redis);
      if (cbState === "OPEN") {
        await ctx.logger.log(`[${this.capability}] Provider "${provider.name}" circuit is OPEN, skipping.`);
        continue;
      }

      const startedAt = Date.now();
      try {
        const data = await provider.fetch(input, ctx);
        const latencyMs = Date.now() - startedAt;

        await recordSuccess(provider.name, ctx.redis);
        await recordProviderMetric(provider.name, { success: true, latencyMs }, ctx.redis);

        return { data, provider: provider.name };
      } catch (err: any) {
        const latencyMs = Date.now() - startedAt;
        lastError = err;

        await recordFailure(provider.name, ctx.redis);
        await recordProviderMetric(provider.name, { success: false, latencyMs }, ctx.redis);

        await ctx.logger.log(
          `[${this.capability}] Provider "${provider.name}" failed: ${err?.message || err}. ` +
            (this.providers.indexOf(provider) < this.providers.length - 1 ? "Trying next provider..." : "No providers left.")
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
