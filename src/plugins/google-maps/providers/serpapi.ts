import { ProviderError, ProviderErrorType } from "@compx/scraper-core";
import type { SourceProvider, ProviderRunContext } from "@compx/scraper-core";
export interface GoogleMapsSerpApiInput {
  query: string;
  maxResults: number;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchFromSerpApi(input: GoogleMapsSerpApiInput, ctx: ProviderRunContext): Promise<any[]> {
  const { query, maxResults } = input;
  const { logger } = ctx;
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) throw new ProviderError(ProviderErrorType.UNAUTHORIZED, "SERPAPI_API_KEY is not set in environment");

  const allResults: any[] = [];
  const seenIds = new Set<string>();
  const maxRetries = 2;
  const MAX_PAGES = 15;
  let hasMore = true;
  let start = 0; // SerpApi uses 0, 20, 40...
  let pageCount = 1;

  while (allResults.length < maxResults && pageCount <= MAX_PAGES && hasMore) {
    await logger.log(`Fetching from SerpApi (page=${pageCount}, start=${start})...`);

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        const params = new URLSearchParams({
          engine: "google_maps",
          q: query,
          api_key: apiKey,
          start: start.toString(),
        });
        
        const res = await fetch(`https://serpapi.com/search.json?${params.toString()}`, {
          method: "GET",
          signal: AbortSignal.timeout(15000),
        });

        if (res.status >= 500 || res.status === 429) {
          throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json();

        if (data.error) {
          throw new Error(data.error);
        }

        const places = data.local_results || [];
        if (places.length === 0) {
          hasMore = false;
        } else {
          const newPlaces = places.filter((p: any) => {
            const id = p.place_id || p.data_id || p.data_cid || `${p.title}-${p.address}`;
            if (seenIds.has(id)) return false;
            seenIds.add(id);
            return true;
          });

          if (newPlaces.length === 0) {
            await logger.log(`  Page ${pageCount} returned only duplicates — stopping.`);
            hasMore = false;
          } else {
            allResults.push(...newPlaces);
          }
          
          if (!data.serpapi_pagination?.next) {
            hasMore = false;
          }
        }

        break;
      } catch (err: any) {
        await logger.log(`SerpApi fetch failed (attempt ${attempt}): ${err.message}`);
        if (attempt <= maxRetries) {
          const delay = Math.pow(2, attempt - 1) * 1000;
          await sleep(delay);
        } else {
          // FIX: previously `throw`n here, which propagated out of
          // fetchFromSerpApi() entirely and discarded every page already
          // collected in allResults (e.g. 14 successful pages / ~280
          // results lost because page 15 hit 3x HTTP 500). SerpApi is a
          // paid API, so losing already-paid-for pages on a late-page
          // transient failure also wastes money on the inevitable re-run.
          // Now we just stop paginating and return what we have, same as
          // the "no more pages" / "only duplicates" paths below — a
          // partial result set is far better than none. The caller
          // (ProviderRouter) still sees this as a provider fetch that
          // returned data, not a failure, so it won't unnecessarily fail
          // over to another provider or record a circuit-breaker failure
          // for what was actually a partial success.
          await logger.log(`  Page ${pageCount} failed after ${maxRetries} retries (${err.message}) — stopping with ${allResults.length} result(s) so far.`);
          hasMore = false;
        }
      }
    }

    if (!hasMore || allResults.length >= maxResults) break;

    start += 20; // Default Google Maps page size in SerpApi is 20
    pageCount++;
    await sleep(1000);
  }

  if (pageCount > MAX_PAGES) {
    await logger.log(`  Reached max page limit (${MAX_PAGES}) — stopping with ${allResults.length} results.`);
  }

  return allResults.slice(0, maxResults);
}

export const googleMapsSerpApiProvider: SourceProvider<GoogleMapsSerpApiInput, any> = {
  name: "google-maps-serpapi",
  fetch: fetchFromSerpApi,
};
