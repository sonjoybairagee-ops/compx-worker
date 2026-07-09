import { ProviderError, ProviderErrorType, checkCircuitBreaker, recordFailure, recordSuccess, CIRCUIT_BREAKER_CONFIG } from "@compx/scraper-core";
import type { Redis } from "ioredis";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchAmazonSerpApi(keyword: string, logger: any, redis: Redis): Promise<any[]> {
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) throw new ProviderError(ProviderErrorType.UNAUTHORIZED, "SERPAPI_API_KEY is not configured");

  const cbState = await checkCircuitBreaker("amazon", redis);
  if (cbState === "OPEN") {
    throw new ProviderError(ProviderErrorType.CIRCUIT_OPEN, "Amazon Circuit is OPEN");
  }

  let success = false;
  let allResults: any[] = [];
  
  for (let attempt = 1; attempt <= CIRCUIT_BREAKER_CONFIG.RETRY_COUNT + 1; attempt++) {
    try {
      await logger.log(`Fetching from SerpApi Amazon engine (attempt ${attempt})...`);
      
      const url = new URL('https://serpapi.com/search');
      url.searchParams.set('engine', 'amazon');
      url.searchParams.set('amazon_domain', 'amazon.com');
      url.searchParams.set('q', keyword);
      url.searchParams.set('api_key', apiKey);
      
      const res = await fetch(url.toString());

      if (res.status >= 500 || res.status === 429) {
        throw new Error(`SerpApi HTTP ${res.status}`);
      }
      
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      allResults = data.amazon_results || [];

      await recordSuccess("amazon", redis);
      success = true;
      break; 
    } catch (err: any) {
      await logger.log(`SerpApi Amazon fetch failed (attempt ${attempt}): ${err.message}`);
      if (attempt <= CIRCUIT_BREAKER_CONFIG.RETRY_COUNT) {
        const delay = CIRCUIT_BREAKER_CONFIG.BACKOFF[attempt - 1] || 2000;
        await sleep(delay);
      } else {
        await recordFailure("amazon", redis);
        throw new Error("SerpApi Amazon request failed after retries");
      }
    }
  }

  return allResults;
}
