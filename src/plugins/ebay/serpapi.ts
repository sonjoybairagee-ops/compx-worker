import { ProviderError, ProviderErrorType, checkCircuitBreaker, recordFailure, recordSuccess, CIRCUIT_BREAKER_CONFIG } from "@compx/scraper-core";
import type { Redis } from "ioredis";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export interface EbayFilters {
  minPrice?: string;
  maxPrice?: string;
  condition?: string; // "Any" | "New" | "Used" | "Open Box" | "Refurbished" | "For Parts"
  ebayDomain?: string; // "ebay.com" | "ebay.co.uk" | ...
  listingType?: string; // "any" | "buy_it_now" | "auction"
  sortBy?: string; // "best_match" | "price_asc" | "price_desc" | "newest" | "ending_soonest" | "most_watched"
  freeShippingOnly?: boolean;
  // NOTE: sellerType, topRatedSellerOnly, minFeedbackScore,
  // minPositiveFeedbackPct, minItemsSold are NOT included here — SerpApi's
  // eBay engine doesn't expose seller-level query params (these aren't
  // filters eBay's own search UI exposes either). They need to be applied
  // as POST-filters in plugins/ebay/index.ts after parsing each result,
  // and only work if parser.js actually extracts seller feedback/type
  // fields from the raw SerpApi response. Check parser.js before assuming
  // these do anything yet.
}

// Best-effort mapping to SerpApi's documented eBay engine params. Verify
// against https://serpapi.com/ebay-search-api before relying on condition
// IDs or sort codes in production — eBay's internal numeric codes for
// item condition (_ItemCondition) and sort order (_sop) are not something
// I could verify without live API access.
const CONDITION_IDS: Record<string, string> = {
  "New": "1000",
  "Used": "3000",
  "Open Box": "1500",
  "Refurbished": "2000",
  "For Parts": "7000",
};

const SORT_CODES: Record<string, string> = {
  best_match: "12",
  price_asc: "15",
  price_desc: "16",
  newest: "10",
  ending_soonest: "1",
  most_watched: "12", // NOTE: SerpApi/eBay has no direct "most watched" sort — falls back to best match. Watch count isn't reliably exposed via this API at all (see the Discover page's own info note about this).
};

export async function fetchEbaySerpApi(
  keyword: string,
  logger: any,
  redis: Redis,
  filters: EbayFilters = {}
): Promise<any[]> {
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) throw new ProviderError(ProviderErrorType.UNAUTHORIZED, "SERPAPI_API_KEY is not configured");

  const cbState = await checkCircuitBreaker("ebay", redis);
  if (cbState === "OPEN") {
    throw new ProviderError(ProviderErrorType.CIRCUIT_OPEN, "eBay Circuit is OPEN");
  }

  let success = false;
  let allResults: any[] = [];
  
  for (let attempt = 1; attempt <= CIRCUIT_BREAKER_CONFIG.RETRY_COUNT + 1; attempt++) {
    try {
      await logger.log(`Fetching from SerpApi eBay engine (attempt ${attempt})...`);
      
      const url = new URL('https://serpapi.com/search');
      url.searchParams.set('engine', 'ebay');
      url.searchParams.set('_nkw', keyword);
      url.searchParams.set('api_key', apiKey);
      url.searchParams.set('ebay_domain', filters.ebayDomain || 'ebay.com');

      if (filters.minPrice) url.searchParams.set('_udlo', filters.minPrice);
      if (filters.maxPrice) url.searchParams.set('_udhi', filters.maxPrice);

      if (filters.condition && filters.condition !== "Any" && CONDITION_IDS[filters.condition]) {
        url.searchParams.set('LH_ItemCondition', CONDITION_IDS[filters.condition]);
      }

      if (filters.listingType === "buy_it_now") url.searchParams.set('LH_BIN', '1');
      if (filters.listingType === "auction") url.searchParams.set('LH_Auction', '1');

      if (filters.freeShippingOnly) url.searchParams.set('LH_FS', '1');

      if (filters.sortBy && SORT_CODES[filters.sortBy]) {
        url.searchParams.set('_sop', SORT_CODES[filters.sortBy]);
      }
      
      const res = await fetch(url.toString());

      if (res.status >= 500 || res.status === 429) {
        throw new Error(`SerpApi HTTP ${res.status}`);
      }
      
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      allResults = data.organic_results || [];

      await recordSuccess("ebay", redis);
      success = true;
      break; 
    } catch (err: any) {
      await logger.log(`SerpApi eBay fetch failed (attempt ${attempt}): ${err.message}`);
      if (attempt <= CIRCUIT_BREAKER_CONFIG.RETRY_COUNT) {
        const delay = CIRCUIT_BREAKER_CONFIG.BACKOFF[attempt - 1] || 2000;
        await sleep(delay);
      } else {
        await recordFailure("ebay", redis);
        throw new Error("SerpApi eBay request failed after retries");
      }
    }
  }

  return allResults;
}
