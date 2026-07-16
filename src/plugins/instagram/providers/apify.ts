/**
 * plugins/instagram/providers/apify.ts
 *
 * Uses Apify's `apify/instagram-scraper` actor to discover and enrich
 * Instagram business profiles by keyword/hashtag.
 *
 * This is the PRIMARY provider for Instagram.
 * Fallback chain: Apify → SerpApi → profile-enricher (own browser scraper)
 *
 * Actor docs: https://apify.com/apify/instagram-scraper
 */
import { ProviderError, ProviderErrorType } from "@compx/scraper-core";
import type { EnrichedProfile } from "./profile-enricher.js";

const APIFY_BASE = "https://api.apify.com/v2";
const ACTOR_ID  = "apify~instagram-scraper";
const TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes max wait

export interface ApifyInstagramInput {
  keyword: string;
  location?: string;
  maxResults?: number;
  filters?: {
    businessOnly?: boolean;
    hasWebsite?: boolean;
    hasPublicEmail?: boolean;
    minFollowers?: number;
    industry?: string;
  };
}

// ─── Apify run helpers ────────────────────────────────────────────────────────

async function startRun(token: string, input: Record<string, unknown>): Promise<string> {
  const url = `${APIFY_BASE}/acts/${ACTOR_ID}/runs?token=${token}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (res.status === 401 || res.status === 403) {
    throw new ProviderError(ProviderErrorType.UNAUTHORIZED, "Invalid APIFY_API_TOKEN");
  }
  if (res.status === 402) {
    throw new ProviderError(ProviderErrorType.PAYMENT_REQUIRED, "Apify account out of credits");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(ProviderErrorType.SERVER_ERROR, `Apify start failed: HTTP ${res.status} — ${text}`);
  }

  const data = await res.json();
  const runId = data?.data?.id;
  if (!runId) throw new ProviderError(ProviderErrorType.SERVER_ERROR, "Apify did not return a run ID");
  return runId as string;
}

async function waitForRun(token: string, runId: string): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(8_000); // poll every 8s
    const res = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${token}`);
    if (!res.ok) continue;
    const data = await res.json();
    const status = data?.data?.status as string;
    if (status === "SUCCEEDED") return data.data.defaultDatasetId as string;
    if (["FAILED", "TIMED-OUT", "ABORTED"].includes(status)) {
      throw new ProviderError(ProviderErrorType.SERVER_ERROR, `Apify run ${status.toLowerCase()}`);
    }
  }
  throw new ProviderError(ProviderErrorType.SERVER_ERROR, "Apify run timed out after 5 minutes");
}

async function fetchDataset(token: string, datasetId: string): Promise<any[]> {
  const url = `${APIFY_BASE}/datasets/${datasetId}/items?token=${token}&format=json&clean=true`;
  const res = await fetch(url);
  if (!res.ok) throw new ProviderError(ProviderErrorType.SERVER_ERROR, `Failed to fetch Apify dataset: HTTP ${res.status}`);
  return res.json();
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ─── Map Apify output → EnrichedProfile ──────────────────────────────────────

function parseFollowerCount(val: any): number | null {
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    const n = parseInt(val.replace(/[^0-9]/g, ""), 10);
    return isNaN(n) ? null : n;
  }
  return null;
}

function mapToEnrichedProfile(item: any): EnrichedProfile | null {
  // Apify instagram-scraper output schema
  const username =
    item.username ||
    item.ownerUsername ||
    item.instagramHandle?.replace("@", "") ||
    null;

  if (!username) return null;

  const email =
    item.businessEmail ||
    item.email ||
    item.publicEmail ||
    null;

  const phone =
    item.businessPhoneNumber ||
    item.phoneNumber ||
    item.phone ||
    null;

  const website =
    item.externalUrl ||
    item.websiteUrl ||
    item.website ||
    null;

  return {
    username,
    name: item.fullName || item.name || username,
    bio: item.biography || item.bio || "",
    email: email || null,
    phone: phone || null,
    website: website || null,
    category: item.businessCategoryName || item.categoryName || null,
    followersCount: parseFollowerCount(item.followersCount || item.followers),
    followingCount: parseFollowerCount(item.followingCount || item.following),
    postsCount: typeof item.postsCount === "number" ? item.postsCount : null,
    isVerified: Boolean(item.verified || item.isVerified),
    isBusiness: Boolean(item.isBusiness || item.businessCategoryName),
    profileUrl: `https://www.instagram.com/${username}/`,
    source: "instagram",
  };
}

// ─── Exported main function ───────────────────────────────────────────────────

export async function discoverInstagramProfilesViaApify(
  input: ApifyInstagramInput
): Promise<EnrichedProfile[]> {
  const apiToken = process.env.APIFY_API_TOKEN;
  if (!apiToken) {
    throw new ProviderError(ProviderErrorType.UNAUTHORIZED, "APIFY_API_TOKEN is not configured");
  }

  const { keyword, location, maxResults = 50, filters = {} } = input;

  // Build hashtag/search terms for the actor
  const searchTerms: string[] = [keyword];
  if (location) searchTerms.push(location);
  if (filters.industry) searchTerms.push(filters.industry);

  // Apify instagram-scraper actor input
  const actorInput: Record<string, unknown> = {
    directUrls: [],                    // we use search, not direct URLs
    resultsType: "posts",              // "posts" gives us author profile data
    resultsLimit: Math.min(maxResults * 3, 200), // over-fetch; we filter later
    searchType: "hashtag",
    searchLimit: maxResults,
    addParentData: true,               // include profile data on each post
    // Hashtag search terms
    hashtags: searchTerms.map(t => t.replace(/\s+/g, "").replace(/^#/, "")),
  };

  console.log(`[Instagram/Apify] Starting actor with terms: ${searchTerms.join(", ")}`);

  const runId = await startRun(apiToken, actorInput);
  console.log(`[Instagram/Apify] Run started: ${runId}`);

  const datasetId = await waitForRun(apiToken, runId);
  console.log(`[Instagram/Apify] Run succeeded, dataset: ${datasetId}`);

  const items = await fetchDataset(apiToken, datasetId);
  console.log(`[Instagram/Apify] Fetched ${items.length} raw items`);

  // Deduplicate by username — multiple posts from the same author
  const seen = new Set<string>();
  const profiles: EnrichedProfile[] = [];

  for (const item of items) {
    // Posts have an "ownerUsername"; profile items use "username"
    const profileData = item.ownerProfile || item;
    const enriched = mapToEnrichedProfile(profileData);
    if (!enriched || seen.has(enriched.username)) continue;

    // Apply filters
    if (filters.businessOnly && !enriched.isBusiness) continue;
    if (filters.hasWebsite && !enriched.website) continue;
    if (filters.hasPublicEmail && !enriched.email) continue;
    if (filters.minFollowers && (enriched.followersCount ?? 0) < filters.minFollowers) continue;

    seen.add(enriched.username);
    profiles.push(enriched);
    if (profiles.length >= maxResults) break;
  }

  console.log(`[Instagram/Apify] ${profiles.length} unique profiles after dedup + filter`);

  if (profiles.length === 0) {
    throw new ProviderError(ProviderErrorType.EMPTY_RESULT, "Apify returned no matching Instagram profiles");
  }

  return profiles;
}
