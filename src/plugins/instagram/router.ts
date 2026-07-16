/**
 * plugins/instagram/router.ts
 *
 * NOTE: The 3-layer hybrid strategy (SerpAPI → Hashtag → Profile Enricher) is
 * now orchestrated directly inside index.ts. This router file is kept for
 * future use if we want to add more SerpAPI-style keyword-search providers
 * (e.g. ScaleSerp, DataForSEO) behind a circuit-breaker fallback chain.
 *
 * For now it is not used by index.ts, but it remains so the capability
 * registry entry ("instagram_keyword_search") stays valid.
 */
export {};
