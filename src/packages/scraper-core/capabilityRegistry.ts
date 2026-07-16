/**
 * scraper-core/capabilityRegistry.ts
 *
 * Maps each capability to an ordered list of provider names. 
 * A plugin's router reads this list to decide which provider to try first.
 *
 * Override in production without a redeploy by setting the
 * CAPABILITY_REGISTRY_JSON env var — useful for emergency vendor swaps.
 */

export type CapabilityConfig = {
  /** Provider names in priority order. First is tried first. */
  providers: string[];
};

const DEFAULT_REGISTRY: Record<string, CapabilityConfig> = {
  google_maps: { providers: ["google-maps-own", "google-maps-serpapi"] },
  website: { providers: ["website-hybrid-crawler"] },
  
  // ✅ Instagram-এর জন্য কাস্টম Playwright Scraper সেট করা হলো
  instagram: { providers: ["instagram-profile-scraper"] },
  instagram_biz: { providers: ["instagram-profile-scraper"] },
  
  // ✅ FIX: Updated to match new Playwright-based provider after removing Apify
  linkedin: { providers: ["linkedin-profile-scraper"] }, 
  
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
    
    // Validate that parsed data has correct shape before merging
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error("Registry override must be a JSON object");
    }

    // Shallow-merge so an override only needs to specify changed capabilities
    return { ...DEFAULT_REGISTRY, ...parsed };
  } catch (err: any) {
    console.error("[capabilityRegistry] CAPABILITY_REGISTRY_JSON parse failed:", err.message);
    console.warn("[capabilityRegistry] Falling back to DEFAULT_REGISTRY");
    return DEFAULT_REGISTRY;
  }
}

let cached: Record<string, CapabilityConfig> | null = null;

export function getCapabilityConfig(capability: string): CapabilityConfig {
  if (!cached) cached = loadRegistry();
  
  const config = cached[capability];
  if (!config || config.providers.length === 0) {
    // Provide helpful hint about available capabilities
    const available = Object.keys(cached).join(", ");
    throw new Error(
      `[capabilityRegistry] No providers configured for "${capability}". Available: ${available}`
    );
  }
  
  return config;
}

/** Test/ops helper — forces a reload on next getCapabilityConfig() call. */
export function _resetCapabilityRegistryCache(): void {
  cached = null;
}