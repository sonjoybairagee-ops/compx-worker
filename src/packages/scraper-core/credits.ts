import type { SupabaseClient } from "@supabase/supabase-js";

export const BASE_SCRAPE_COSTS: Record<string, number> = {
  // Must match CREDIT_COSTS in src/utils/plans.ts
  website:     2,  // website_scrape
  websites:    2,  // alias
  google_maps: 1,  // google_maps_scrape
  youtube:     2,  // youtube_scrape
  instagram:   2,  // instagram_scrape (instagram_biz alias)
  instagram_biz: 2,
  facebook:    2,  // facebook_scrape
  linkedin:    4,  // linkedin_scrape
  amazon:      4,  // amazon_scrape
  ebay:        2,  // ebay_scrape
  tripadvisor: 3,  // tripadvisor_scrape
};

export const ENRICHMENT_COSTS: Record<string, number> = {
  email: 2, // mapped from input.enrichments.email
  email_verify: 2,
  bulk_email_verify: 1,
  website_enrichment: 2,
  bulk_website_enrichment: 1,
  bulk_enrichment: 1,
  force_reenrichment: 2,
  company_enrichment: 2,
  ai: 1, // mapped from input.enrichments.ai
  ai_score: 1,
  ai_summary: 1,
  ai_icebreaker: 1,
  ai_company_insights: 2,
  ai_review_sentiment: 2,
  phone_enrichment: 2,
  hiring_signal: 2,
  tech: 2, // mapped from input.enrichments.tech
  tech_stack: 2,
};

export interface LeadBillingMetadata {
  isCacheHit?: boolean;
  enrichments?: string[]; // Array of enrichment keys from ENRICHMENT_COSTS
  isFailed?: boolean;
  isPartial?: boolean;
  status?: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'NO_DATA' | 'SYSTEM_ERROR' | 'RATE_LIMITED' | 'CACHE_HIT' | 'PROXY_ERROR' | 'TIMEOUT' | 'INTERNAL_ERROR';
}

export function getBaseCost(source: string): number {
  // Normalize source name (e.g. google-maps -> google_maps)
  const normalized = source.replace("-", "_");
  return BASE_SCRAPE_COSTS[normalized] ?? 1; // Default to 1 if not found
}

export function calculateLeadCost(source: string, metadata?: LeadBillingMetadata): number {
  // Success-Based & Hybrid Billing: System failures = 0, but NO_DATA (crawl completed but nothing found) = Full
  if (
    metadata?.isFailed || 
    metadata?.status === 'FAILED' || 
    metadata?.status === 'SYSTEM_ERROR' || 
    metadata?.status === 'RATE_LIMITED' ||
    metadata?.status === 'PROXY_ERROR' ||
    metadata?.status === 'TIMEOUT' ||
    metadata?.status === 'INTERNAL_ERROR'
  ) return 0;

  // Cache hit is now free
  if (metadata?.isCacheHit || metadata?.status === 'CACHE_HIT') return 0;

  let baseCredits = getBaseCost(source);
  let enrichmentCredits = 0;

  if (metadata?.enrichments && metadata.enrichments.length > 0) {
    for (const enrichment of metadata.enrichments) {
      enrichmentCredits += (ENRICHMENT_COSTS[enrichment] ?? 0);
    }
  }

  let totalCost = baseCredits + enrichmentCredits;

  // Partial success logic (50% charge)
  if (metadata?.isPartial || metadata?.status === 'PARTIAL') {
    totalCost = Math.ceil(totalCost * 0.5);
  }

  return totalCost;
}

export function calculateBatchCost(count: number, costPerLead: number): number {
  if (count <= 0) return 0;
  
  // Bulk Discount Multipliers
  let multiplier = 1.0;
  if (count > 2000) multiplier = 0.85;
  else if (count > 500) multiplier = 0.90;
  else if (count > 100) multiplier = 0.95;

  return Math.ceil(count * costPerLead * multiplier);
}
