/**
 * plugins/google-maps/providers/serper.ts — moved from google-maps/index.ts's
 * inline fetchFromSerper(). Circuit-breaker check/record now lives in the
 * router, keyed by "google-maps-serper" (was "serper" — a generic vendor
 * name, fine today but would collide if another plugin also called Serper).
 */
import { ProviderError, ProviderErrorType } from "@compx/scraper-core";
import type { SourceProvider, ProviderRunContext } from "@compx/scraper-core";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export interface GoogleMapsSerperInput {
  query: string;
  maxResults: number;
}

async function fetchFromSerper(input: GoogleMapsSerperInput, ctx: ProviderRunContext): Promise<any[]> {
  const { query, maxResults } = input;
  const { logger } = ctx;
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) throw new ProviderError(ProviderErrorType.UNAUTHORIZED, "SERPER_API_KEY is not set in environment");

  const allResults: any[] = [];
  let page = 1;
  const maxRetries = 2;

  while (allResults.length < maxResults) {
    await logger.log(`Fetching from Serper.dev (page=${page})...`);

    let success = false;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        const res = await fetch("https://google.serper.dev/places", {
          method: "POST",
          headers: {
            "X-API-KEY": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ q: query, page }),
          signal: AbortSignal.timeout(10000),
        });

        if (res.status >= 500 || res.status === 429) {
          throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json();

        if (data.message && data.statusCode) {
          throw new Error(data.message);
        }

        const places = data.places || [];
        allResults.push(...places);

        success = true;
        break;
      } catch (err: any) {
        await logger.log(`Serper API fetch failed (attempt ${attempt}): ${err.message}`);
        if (attempt <= maxRetries) {
          const delay = Math.pow(2, attempt - 1) * 1000;
          await sleep(delay);
        } else {
          throw new Error("Serper request failed after retries");
        }
      }
    }

    if (!success || allResults.length >= maxResults) break;

    page++;
    await sleep(1000);
  }

  return allResults.slice(0, maxResults);
}

export const googleMapsSerperProvider: SourceProvider<GoogleMapsSerperInput, any> = {
  name: "google-maps-serper",
  fetch: fetchFromSerper,
};
