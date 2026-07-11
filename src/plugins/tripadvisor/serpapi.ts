import { ProviderError, ProviderErrorType, checkCircuitBreaker, recordFailure, recordSuccess, CIRCUIT_BREAKER_CONFIG } from "@compx/scraper-core";
import type { Redis } from "ioredis";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export interface TripadvisorFilters {
  category?: string; // "any" | "hotels" | "restaurants" | "attractions"
  minRating?: string;
  minReviews?: string;
  priceLevel?: string; // "any" | "$" | "$$" | "$$$" | "$$$$"
  sortBy?: string;
  hasWebsite?: boolean;
  painPointKeywords?: string;
}

const CATEGORY_HINTS: Record<string, string> = {
  hotels: "hotel",
  restaurants: "restaurant",
  attractions: "attraction things to do",
};

// This is a Google `site:tripadvisor.com` search via SerpApi, NOT a native
// Tripadvisor API — there's no real API param for rating/price-level/
// review-count, so category and pain-point keywords get folded directly
// into the search query text instead (biases which indexed pages Google
// surfaces). minRating, minReviews, priceLevel, and hasWebsite CANNOT be
// applied here — they have to be post-filtered in plugins/tripadvisor/
// index.ts after parsing, and only work if parser.js actually extracts a
// rating/review_count/price_level field from the scraped page. Verify
// that before relying on it.
export async function fetchTripadvisorSerpApi(
  keyword: string,
  location: string | undefined,
  logger: any,
  redis: Redis,
  filters: TripadvisorFilters = {}
): Promise<any[]> {
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) throw new ProviderError(ProviderErrorType.UNAUTHORIZED, "SERPAPI_API_KEY is not configured");

  const cbState = await checkCircuitBreaker("serpapi", redis);
  if (cbState === "OPEN") {
    throw new ProviderError(ProviderErrorType.CIRCUIT_OPEN, "SerpApi Circuit is OPEN");
  }

  let success = false;
  let allResults: any[] = [];
  
  for (let attempt = 1; attempt <= CIRCUIT_BREAKER_CONFIG.RETRY_COUNT + 1; attempt++) {
    try {
      await logger.log(`Fetching from SerpApi Google engine for Tripadvisor (attempt ${attempt})...`);

      const parts = [keyword];
      if (location) parts.push(location);
      if (filters.category && filters.category !== "any" && CATEGORY_HINTS[filters.category]) {
        parts.push(CATEGORY_HINTS[filters.category]);
      }
      if (filters.painPointKeywords?.trim()) {
        parts.push(filters.painPointKeywords.trim());
      }
      parts.push("site:tripadvisor.com");
      const query = parts.join(" ");

      const url = new URL('https://serpapi.com/search');
      url.searchParams.set('engine', 'google');
      url.searchParams.set('q', query);
      url.searchParams.set('num', '20');
      url.searchParams.set('api_key', apiKey);
      
      const res = await fetch(url.toString());

      if (res.status >= 500 || res.status === 429) {
        throw new Error(`SerpApi HTTP ${res.status}`);
      }
      
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      allResults = data.organic_results || [];

      await recordSuccess("serpapi", redis);
      success = true;
      break; 
    } catch (err: any) {
      await logger.log(`SerpApi Tripadvisor fetch failed (attempt ${attempt}): ${err.message}`);
      if (attempt <= CIRCUIT_BREAKER_CONFIG.RETRY_COUNT) {
        const delay = CIRCUIT_BREAKER_CONFIG.BACKOFF[attempt - 1] || 2000;
        await sleep(delay);
      } else {
        await recordFailure("serpapi", redis);
        throw new Error("SerpApi request failed after retries");
      }
    }
  }

  return allResults;
}
