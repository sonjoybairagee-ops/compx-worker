/**
 * plugins/ebay/providers/serpapi.ts — moved from ebay/serpapi.ts.
 * Circuit-breaker check/record now lives in the router (provider.ts),
 * keyed by "ebay-serpapi" instead of the old plugin-name key "ebay".
 */
import { ProviderError, ProviderErrorType, CIRCUIT_BREAKER_CONFIG } from "@compx/scraper-core";
import type { SourceProvider, ProviderRunContext } from "@compx/scraper-core";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export interface EbayFilters {
  minPrice?: string;
  maxPrice?: string;
  condition?: string;
  ebayDomain?: string;
  listingType?: string;
  sortBy?: string;
  freeShippingOnly?: boolean;
}

export interface EbayProviderInput {
  keyword: string;
  filters?: EbayFilters;
}

const CONDITION_IDS: Record<string, string> = {
  New: "1000",
  Used: "3000",
  "Open Box": "1500",
  Refurbished: "2000",
  "For Parts": "7000",
};

const SORT_CODES: Record<string, string> = {
  best_match: "12",
  price_asc: "15",
  price_desc: "16",
  newest: "10",
  ending_soonest: "1",
  most_watched: "12",
};

async function fetchEbaySerpApi(input: EbayProviderInput, ctx: ProviderRunContext): Promise<any[]> {
  const { keyword, filters = {} } = input;
  const { logger } = ctx;
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) throw new ProviderError(ProviderErrorType.UNAUTHORIZED, "SERPAPI_API_KEY is not configured");

  let allResults: any[] = [];

  for (let attempt = 1; attempt <= CIRCUIT_BREAKER_CONFIG.RETRY_COUNT + 1; attempt++) {
    try {
      await logger.log(`Fetching from SerpApi eBay engine (attempt ${attempt})...`);

      const url = new URL("https://serpapi.com/search");
      url.searchParams.set("engine", "ebay");
      url.searchParams.set("_nkw", keyword);
      url.searchParams.set("api_key", apiKey);
      url.searchParams.set("ebay_domain", filters.ebayDomain || "ebay.com");

      if (filters.minPrice) url.searchParams.set("_udlo", filters.minPrice);
      if (filters.maxPrice) url.searchParams.set("_udhi", filters.maxPrice);

      if (filters.condition && filters.condition !== "Any" && CONDITION_IDS[filters.condition]) {
        url.searchParams.set("LH_ItemCondition", CONDITION_IDS[filters.condition]);
      }

      if (filters.listingType === "buy_it_now") url.searchParams.set("LH_BIN", "1");
      if (filters.listingType === "auction") url.searchParams.set("LH_Auction", "1");

      if (filters.freeShippingOnly) url.searchParams.set("LH_FS", "1");

      if (filters.sortBy && SORT_CODES[filters.sortBy]) {
        url.searchParams.set("_sop", SORT_CODES[filters.sortBy]);
      }

      const res = await fetch(url.toString());

      if (res.status >= 500 || res.status === 429) {
        throw new Error(`SerpApi HTTP ${res.status}`);
      }

      const data = await res.json();
      if (data.error) throw new Error(data.error);

      allResults = data.organic_results || [];
      return allResults;
    } catch (err: any) {
      await logger.log(`SerpApi eBay fetch failed (attempt ${attempt}): ${err.message}`);
      if (attempt <= CIRCUIT_BREAKER_CONFIG.RETRY_COUNT) {
        const delay = CIRCUIT_BREAKER_CONFIG.BACKOFF[attempt - 1] || 2000;
        await sleep(delay);
      } else {
        throw new Error("SerpApi eBay request failed after retries");
      }
    }
  }

  return allResults;
}

export const ebaySerpApiProvider: SourceProvider<EbayProviderInput, any> = {
  name: "ebay-serpapi",
  fetch: fetchEbaySerpApi,
};
