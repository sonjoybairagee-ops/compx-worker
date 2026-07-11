/**
 * plugins/instagram/router.ts
 *
 * NOTE on scope: Instagram has two genuinely different data-fetch paths —
 * (1) SerpApi keyword search, and (2) a Playwright browser scrape of
 * specific profile URLs (plugins/instagram/index.ts's runFallbackScrape).
 * These are NOT interchangeable providers for the same input — SerpApi
 * takes a keyword, the Playwright path takes a list of profile URLs — so
 * routing them through one ProviderRouter with automatic fallback would
 * misrepresent what actually happens today (a keyword-search failure does
 * NOT currently fall back to a browser scrape; only explicit profileUrls
 * trigger the browser path). Formalizing that as a false "fallback chain"
 * would be worse than leaving it honest.
 *
 * What IS done here: the SerpApi call is a proper SourceProvider behind a
 * router (so its circuit breaker / metrics / capability-registry ordering
 * work exactly like every other plugin, and a second keyword-search
 * provider can be added later with zero index.ts changes). The Playwright
 * profile-scrape path stays directly in index.ts, called explicitly when
 * profileUrls are present — same behavior as before, just documented.
 */
import { ProviderRouter, getCapabilityConfig } from "@compx/scraper-core";
import { instagramSerpApiProvider, type InstagramSerpApiInput } from "./providers/serpapi.js";

const PROVIDER_MAP = {
  "instagram-serpapi": instagramSerpApiProvider,
};

function buildRouter(): ProviderRouter<InstagramSerpApiInput, any> {
  const { providers: names } = getCapabilityConfig("instagram_keyword_search");
  const providers = names.map((n) => {
    const p = (PROVIDER_MAP as Record<string, typeof instagramSerpApiProvider>)[n];
    if (!p) throw new Error(`[instagram] Unknown provider "${n}" in capability registry`);
    return p;
  });
  return new ProviderRouter<InstagramSerpApiInput, any>(providers, { capability: "instagram_keyword_search" });
}

export const instagramRouter = buildRouter();
