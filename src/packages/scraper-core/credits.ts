import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Base scraping costs per source.
 * Must match CREDIT_COSTS in src/utils/plans.ts for UI consistency.
 */
export const BASE_SCRAPE_COSTS: Record<string, number> = {
  website:      2,
  websites:     2, // alias
  google_maps:  1,
  youtube:      2,
  instagram:    2,
  instagram_biz: 2, // alias
  facebook:     2,
  linkedin:     4,
  amazon:       4,
  ebay:         2,
  tripadvisor:  3,
};

/**
 * Enrichment costs. Keys must match input.enrichments keys exactly.
 */
export const ENRICHMENT_COSTS: Record<string, number> = {
  email:                 2,
  email_verify:          2,
  bulk_email_verify:     1,
  website_enrichment:    2,
  bulk_website_enrichment: 1,
  bulk_enrichment:       1,
  force_reenrichment:    2,
  company_enrichment:    2,
  ai:                    1,
  ai_score:              1,
  ai_summary:            1,
  ai_icebreaker:         1,
  ai_company_insights:   2,
  ai_review_sentiment:   2,
  phone_enrichment:      2,
  hiring_signal:         2,
  tech:                  2,
  tech_stack:            2,
};

export interface LeadBillingMetadata {
  isCacheHit?: boolean;
  enrichments?: string[];
  isFailed?: boolean;
  isPartial?: boolean;
  status?: 
    | 'SUCCESS' 
    | 'PARTIAL' 
    | 'FAILED' 
    | 'NO_DATA' 
    | 'SYSTEM_ERROR' 
    | 'RATE_LIMITED' 
    | 'CACHE_HIT' 
    | 'PROXY_ERROR' 
    | 'TIMEOUT' 
    | 'INTERNAL_ERROR';
}

/**
 * Gets base cost for a source with safe normalization.
 */
export function getBaseCost(source: string): number {
  const normalized = source.toLowerCase().replace(/[-\s]+/g, "_");
  return BASE_SCRAPE_COSTS[normalized] ?? 1; // Default fallback to prevent $0 charges
}

/**
 * Calculates cost for a single lead based on success-based billing.
 * System failures = 0 credits. NO_DATA = Full charge (crawl completed).
 */
export function calculateLeadCost(source: string, metadata?: LeadBillingMetadata): number {
  // ✅ FIX: Explicitly handle NO_DATA as full charge (user's request was fulfilled, just no results)
  if (metadata?.status === 'NO_DATA') {
    let baseCredits = getBaseCost(source);
    let enrichmentCredits = 0;
    
    if (metadata?.enrichments?.length) {
      for (const e of metadata.enrichments) {
        enrichmentCredits += ENRICHMENT_COSTS[e] ?? 0;
      }
    }
    return baseCredits + enrichmentCredits;
  }

  // Zero-cost scenarios: system failures or cache hits
  const zeroCostStatuses = [
    'FAILED', 'SYSTEM_ERROR', 'RATE_LIMITED', 
    'PROXY_ERROR', 'TIMEOUT', 'INTERNAL_ERROR'
  ];

  if (
    metadata?.isFailed || 
    (metadata?.status && zeroCostStatuses.includes(metadata.status)) ||
    metadata?.isCacheHit || 
    metadata?.status === 'CACHE_HIT'
  ) {
    return 0;
  }

  // Calculate base + enrichment costs
  let totalCost = getBaseCost(source);

  if (metadata?.enrichments?.length) {
    for (const enrichment of metadata.enrichments) {
      totalCost += ENRICHMENT_COSTS[enrichment] ?? 0;
    }
  }

  // Partial success = 50% discount (rounded up)
  if (metadata?.isPartial || metadata?.status === 'PARTIAL') {
    return Math.ceil(totalCost * 0.5);
  }

  return totalCost;
}

/**
 * Calculates batch cost with volume discounts.
 * Used for upfront pricing estimates, NOT for actual deduction.
 */
export function calculateBatchCost(count: number, costPerLead: number): number {
  if (count <= 0 || costPerLead <= 0) return 0;
  
  // Volume discount tiers
  let multiplier = 1.0;
  if (count > 2000)      multiplier = 0.85; // 15% off
  else if (count > 500)  multiplier = 0.90; // 10% off
  else if (count > 100)  multiplier = 0.95; // 5% off

  return Math.ceil(count * costPerLead * multiplier);
}