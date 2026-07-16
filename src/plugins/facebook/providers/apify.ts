/**
 * plugins/facebook/providers/apify.ts
 *
 * Uses Apify's `apify/facebook-pages-scraper` actor to discover and enrich
 * Facebook Business Pages by keyword/location.
 *
 * This is the PRIMARY provider for Facebook.
 * Fallback chain: Apify → SerpApi → own page-scraper (browser)
 *
 * Actor docs: https://apify.com/apify/facebook-pages-scraper
 */
import { ProviderError, ProviderErrorType } from "@compx/scraper-core";
import type { FacebookPageStub } from "./serpapi.js";
import type { FacebookPageData } from "./page-scraper.js";

const APIFY_BASE = "https://api.apify.com/v2";
const ACTOR_ID   = "apify~facebook-pages-scraper";
const TIMEOUT_MS = 6 * 60 * 1_000; // 6 minutes

export interface ApifyFacebookInput {
  keyword: string;
  location?: string;
  maxResults?: number;
}

/** Combined result shape: stub + deep data merged (same as buildLeadRecord input) */
export interface ApifyFacebookResult {
  stub: FacebookPageStub;
  deep: FacebookPageData;
}

// ─── Apify helpers ────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function startRun(token: string, actorId: string, input: Record<string, unknown>): Promise<string> {
  const url = `${APIFY_BASE}/acts/${actorId}/runs?token=${token}`;
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
    await sleep(8_000);
    const res = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${token}`);
    if (!res.ok) continue;
    const data = await res.json();
    const status = data?.data?.status as string;
    if (status === "SUCCEEDED") return data.data.defaultDatasetId as string;
    if (["FAILED", "TIMED-OUT", "ABORTED"].includes(status)) {
      throw new ProviderError(ProviderErrorType.SERVER_ERROR, `Apify run ${status.toLowerCase()}`);
    }
  }
  throw new ProviderError(ProviderErrorType.SERVER_ERROR, "Apify run timed out after 6 minutes");
}

async function fetchDataset(token: string, datasetId: string): Promise<any[]> {
  const url = `${APIFY_BASE}/datasets/${datasetId}/items?token=${token}&format=json&clean=true`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new ProviderError(ProviderErrorType.SERVER_ERROR, `Failed to fetch Apify dataset: HTTP ${res.status}`);
  }
  return res.json();
}

function parseFollowerCount(val: any): number | null {
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    const n = parseInt(val.replace(/[^0-9]/g, ""), 10);
    return isNaN(n) ? null : n;
  }
  return null;
}

// ─── Map Apify output → stub + deep pair ─────────────────────────────────────

function mapToFacebookResult(item: any): ApifyFacebookResult | null {
  const pageUrl =
    item.url ||
    item.pageUrl ||
    item.facebookUrl ||
    null;

  if (!pageUrl || !pageUrl.includes("facebook.com")) return null;

  let pageSlug = "";
  try {
    const u = new URL(pageUrl);
    const parts = u.pathname.replace(/\/$/, "").split("/").filter(Boolean);
    pageSlug = parts[parts.length - 1] || "";
  } catch {
    return null;
  }

  if (!pageSlug) return null;

  const name =
    item.title ||
    item.name ||
    item.pageName ||
    pageSlug;

  const followersCount = parseFollowerCount(
    item.likes || item.followers || item.followersCount
  );

  // Build stub (same as SerpApi stub shape)
  const stub: FacebookPageStub = {
    pageUrl: `https://www.facebook.com/${pageSlug}/`,
    pageSlug,
    name,
    about: item.about || item.description || item.intro || "",
    followersCount,
    category: item.category || item.pageCategory || null,
    website: item.website || item.websiteUrl || null,
    phone: item.phone || item.phoneNumber || null,
  };

  // Build deep data (same as page-scraper shape)
  const deep: FacebookPageData = {
    pageUrl: stub.pageUrl,
    pageSlug,
    name,
    phone: item.phone || item.phoneNumber || null,
    email: item.email || item.emailAddress || null,
    website: item.website || item.websiteUrl || null,
    address: item.address || item.location || null,
    category: item.category || item.pageCategory || null,
    rating: typeof item.rating === "number" ? item.rating : null,
    reviewCount: typeof item.reviewsCount === "number"
      ? item.reviewsCount
      : typeof item.checkins === "number"
        ? item.checkins
        : null,
    followersCount,
    about: item.about || item.description || item.intro || null,
  };

  return { stub, deep };
}

// ─── Exported main function ───────────────────────────────────────────────────

export async function discoverFacebookPagesViaApify(
  input: ApifyFacebookInput
): Promise<ApifyFacebookResult[]> {
  const apiToken = process.env.APIFY_API_TOKEN;
  if (!apiToken) {
    throw new ProviderError(ProviderErrorType.UNAUTHORIZED, "APIFY_API_TOKEN is not configured");
  }

  const { keyword, location, maxResults = 25 } = input;
  const searchQuery = location ? `${keyword} ${location}` : keyword;

  // facebook-pages-scraper actor input
  const actorInput: Record<string, unknown> = {
    // Search term — actor will search Facebook directly
    startUrls: [{
      url: `https://www.facebook.com/search/pages/?q=${encodeURIComponent(searchQuery)}`,
    }],
    maxPagesPerQuery: maxResults,
    scrapeAbout: true,         // get phone/email/website/address
    scrapeReviews: false,      // skip review text to keep it fast
    language: "en-US",
    proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
  };

  console.log(`[Facebook/Apify] Starting actor for "${searchQuery}", max ${maxResults} pages`);

  const runId = await startRun(apiToken, ACTOR_ID, actorInput);
  console.log(`[Facebook/Apify] Run started: ${runId}`);

  const datasetId = await waitForRun(apiToken, runId);
  console.log(`[Facebook/Apify] Run succeeded, dataset: ${datasetId}`);

  const items = await fetchDataset(apiToken, datasetId);
  console.log(`[Facebook/Apify] Fetched ${items.length} raw items`);

  const seen = new Set<string>();
  const results: ApifyFacebookResult[] = [];

  for (const item of items) {
    const result = mapToFacebookResult(item);
    if (!result || seen.has(result.stub.pageSlug)) continue;
    seen.add(result.stub.pageSlug);
    results.push(result);
    if (results.length >= maxResults) break;
  }

  console.log(`[Facebook/Apify] ${results.length} unique pages after dedup`);

  if (results.length === 0) {
    throw new ProviderError(ProviderErrorType.EMPTY_RESULT, "Apify returned no Facebook pages");
  }

  return results;
}
