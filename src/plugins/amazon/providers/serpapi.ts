/**
 * plugins/amazon/providers/serpapi.ts
 *
 * Moved out of amazon/serpapi.ts unchanged in behavior, with one fix:
 * circuit-breaker check/record used to happen INSIDE this file under the
 * key "amazon" (the plugin name, not the provider name). That was a latent
 * bug — if a second Amazon provider is ever added, it would have shared
 * this same breaker key and one vendor's failures would trip the circuit
 * for both. The router (provider.ts) now owns circuit-breaker state,
 * keyed by provider.name ("amazon-serpapi"), so this file only does what a
 * provider should: call the vendor and retry transient failures.
 */
import { ProviderError, ProviderErrorType, CIRCUIT_BREAKER_CONFIG } from "@compx/scraper-core";
import type { SourceProvider, ProviderRunContext } from "@compx/scraper-core";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export interface AmazonProviderInput {
  keyword: string;
}

async function fetchAmazonSerpApi(input: AmazonProviderInput, ctx: ProviderRunContext): Promise<any[]> {
  const { keyword } = input;
  const { logger } = ctx;
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) throw new ProviderError(ProviderErrorType.UNAUTHORIZED, "SERPAPI_API_KEY is not configured");

  let allResults: any[] = [];

  for (let attempt = 1; attempt <= CIRCUIT_BREAKER_CONFIG.RETRY_COUNT + 1; attempt++) {
    try {
      await logger.log(`Fetching from SerpApi Amazon engine (attempt ${attempt})...`);

      const url = new URL("https://serpapi.com/search");
      url.searchParams.set("engine", "amazon");
      url.searchParams.set("amazon_domain", "amazon.com");
      // SerpApi's Amazon engine takes the search keyword as `k` (or a
      // `node` category id), NOT `q` — `q` is the Google-family param name.
      url.searchParams.set("k", keyword);
      url.searchParams.set("api_key", apiKey);

      const res = await fetch(url.toString());

      if (res.status >= 500 || res.status === 429) {
        throw new Error(`SerpApi HTTP ${res.status}`);
      }

      const data = await res.json();
      if (data.error) throw new Error(data.error);

      // SerpApi's Amazon engine returns product listings under
      // `organic_results`, not `amazon_results`.
      allResults = data.organic_results || [];
      return allResults;
    } catch (err: any) {
      await logger.log(`SerpApi Amazon fetch failed (attempt ${attempt}): ${err.message}`);
      if (attempt <= CIRCUIT_BREAKER_CONFIG.RETRY_COUNT) {
        const delay = CIRCUIT_BREAKER_CONFIG.BACKOFF[attempt - 1] || 2000;
        await sleep(delay);
      } else {
        throw new Error("SerpApi Amazon request failed after retries");
      }
    }
  }

  return allResults;
}

export const amazonSerpApiProvider: SourceProvider<AmazonProviderInput, any> = {
  name: "amazon-serpapi",
  fetch: fetchAmazonSerpApi,
};
