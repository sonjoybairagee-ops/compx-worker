/**
 * scraper-core/capabilityRegistry.ts
 *
 * Maps each capability (google_maps, website, linkedin, ...) to an ordered
 * list of provider names. A plugin's router reads this list to decide which
 * provider to try first and what to fall back to.
 *
 * Today every capability has exactly one provider — that's an accurate
 * reflection of reality, not a limitation of the registry. Adding a second
 * provider (e.g. own-scraper for google_maps) is a one-line change here;
 * it does NOT require touching the plugin's index.ts.
 *
 * Override in production without a redeploy by setting the
 * CAPABILITY_REGISTRY_JSON env var to a JSON object with the same shape —
 * useful for an emergency provider swap (e.g. a vendor outage) without
 * shipping code.
 */

export type CapabilityConfig = {
  /** Provider names in priority order. First is tried first. */
  providers: string[];
};

const DEFAULT_REGISTRY: Record<string, CapabilityConfig> = {
  google_maps: { providers: ["google-maps-own", "google-maps-serpapi"] },
  website: { providers: ["website-hybrid-crawler"] },
  // NOTE: Instagram profile-URL scraping (Playwright, direct URLs) is a
  // separate code path in plugins/instagram/index.ts, not registered here
  // — see plugins/instagram/router.ts for why. This key covers only the
  // keyword-search path.
  instagram_keyword_search: { providers: ["instagram-serpapi"] },
  linkedin: { providers: ["linkedin-apify"] },
  youtube: { providers: ["youtube-about-page-scraper"] },
  amazon: { providers: ["amazon-serpapi"] },
  facebook: { providers: ["facebook-serpapi"] },
  ebay: { providers: ["ebay-serpapi"] },
  tripadvisor: { providers: ["tripadvisor-serpapi"] },
};

function loadRegistry(): Record<string, CapabilityConfig> {
  const raw = process.env.CAPABILITY_REGISTRY_JSON;
  if (!raw) return DEFAULT_REGISTRY;
  try {
    const parsed = JSON.parse(raw);
    // Shallow-merge so an override only needs to specify the capabilities
    // it's actually changing, not the entire registry.
    return { ...DEFAULT_REGISTRY, ...parsed };
  } catch (err) {
    console.warn("[capabilityRegistry] CAPABILITY_REGISTRY_JSON is not valid JSON, using defaults:", err);
    return DEFAULT_REGISTRY;
  }
}

let cached: Record<string, CapabilityConfig> | null = null;

export function getCapabilityConfig(capability: string): CapabilityConfig {
  if (!cached) cached = loadRegistry();
  const config = cached[capability];
  if (!config || config.providers.length === 0) {
    throw new Error(`[capabilityRegistry] No providers configured for capability "${capability}"`);
  }
  return config;
}

/** Test/ops helper — forces a reload on next getCapabilityConfig() call. */
export function _resetCapabilityRegistryCache(): void {
  cached = null;
}
