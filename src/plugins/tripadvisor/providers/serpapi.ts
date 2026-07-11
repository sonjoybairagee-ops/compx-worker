/**
 * plugins/tripadvisor/providers/serpapi.ts — moved from tripadvisor/serpapi.ts.
 *
 * FIX: the old file's circuit breaker used a generic key "serpapi" — shared
 * by name with nothing else in the codebase by luck, but if any other
 * plugin ever added a "serpapi" breaker key, they'd have shared circuit
 * state incorrectly. Now keyed by "tripadvisor-serpapi" (this provider's
 * own identity) via the router, consistent with every other plugin.
 */
import { ProviderError, ProviderErrorType, CIRCUIT_BREAKER_CONFIG } from "@compx/scraper-core";
import type { SourceProvider, ProviderRunContext } from "@compx/scraper-core";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export interface TripadvisorFilters {
  category?: string;
  minRating?: string;
  minReviews?: string;
  priceLevel?: string;
  sortBy?: string;
  hasWebsite?: boolean;
  painPointKeywords?: string;
}

export interface TripadvisorProviderInput {
  keyword: string;
  location?: string;
  filters?: TripadvisorFilters;
}

const SSRC_BY_CATEGORY: Record<string, string> = {
  restaurants: "r",
  hotels: "h",
  attractions: "A",
};

async function fetchTripadvisorSerpApi(input: TripadvisorProviderInput, ctx: ProviderRunContext): Promise<any[]> {
  const { keyword, location, filters = {} } = input;
  const { logger } = ctx;
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) throw new ProviderError(ProviderErrorType.UNAUTHORIZED, "SERPAPI_API_KEY is not configured");

  let allResults: any[] = [];

  for (let attempt = 1; attempt <= CIRCUIT_BREAKER_CONFIG.RETRY_COUNT + 1; attempt++) {
    try {
      await logger.log(`Fetching from SerpApi Tripadvisor engine (attempt ${attempt})...`);

      const parts = [keyword];
      if (location) parts.push(location);
      if (filters.painPointKeywords?.trim()) {
        parts.push(filters.painPointKeywords.trim());
      }
      const query = parts.join(" ");

      const url = new URL("https://serpapi.com/search");
      url.searchParams.set("engine", "tripadvisor");
      url.searchParams.set("q", query);
      url.searchParams.set("limit", "30");
      const ssrc = filters.category && filters.category !== "any" ? SSRC_BY_CATEGORY[filters.category] : undefined;
      if (ssrc) url.searchParams.set("ssrc", ssrc);
      url.searchParams.set("api_key", apiKey);

      const res = await fetch(url.toString());

      if (res.status >= 500 || res.status === 429) {
        throw new Error(`SerpApi HTTP ${res.status}`);
      }

      const data = await res.json();
      if (data.error) throw new Error(data.error);

      allResults = data.places || [];
      return allResults;
    } catch (err: any) {
      await logger.log(`SerpApi Tripadvisor fetch failed (attempt ${attempt}): ${err.message}`);
      if (attempt <= CIRCUIT_BREAKER_CONFIG.RETRY_COUNT) {
        const delay = CIRCUIT_BREAKER_CONFIG.BACKOFF[attempt - 1] || 2000;
        await sleep(delay);
      } else {
        throw new Error("SerpApi request failed after retries");
      }
    }
  }

  return allResults;
}

export const tripadvisorSerpApiProvider: SourceProvider<TripadvisorProviderInput, any> = {
  name: "tripadvisor-serpapi",
  fetch: fetchTripadvisorSerpApi,
};
