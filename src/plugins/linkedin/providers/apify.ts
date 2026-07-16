/**
 * plugins/linkedin/providers/apify.ts
 *
 * Uses Apify's `apify/linkedin-profile-scraper` actor to discover and enrich
 * LinkedIn profiles and company pages by keyword/location.
 *
 * This is the PRIMARY provider for LinkedIn.
 * Fallback chain: Apify → SerpApi → own profile-scraper (browser session)
 *
 * Actor docs: https://apify.com/apify/linkedin-profile-scraper
 */
import { ProviderError, ProviderErrorType } from "@compx/scraper-core";
import type { LinkedinEnrichedProfile } from "./profile-scraper.js";

const APIFY_BASE  = "https://api.apify.com/v2";
const ACTOR_ID    = "apify~linkedin-profile-scraper";
const TIMEOUT_MS  = 6 * 60 * 1_000; // 6 minutes max wait

export interface ApifyLinkedinInput {
  keyword: string;
  location?: string;
  searchType?: "people" | "company" | "both";
  maxResults?: number;
  jobTitles?: string[];
  targetAudiences?: string[];
}

// ─── Apify run helpers ────────────────────────────────────────────────────────

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

// ─── Map Apify output → LinkedinEnrichedProfile ───────────────────────────────

function mapToLinkedinProfile(item: any): LinkedinEnrichedProfile | null {
  const profileUrl =
    item.linkedinUrl ||
    item.profileUrl ||
    item.url ||
    null;

  if (!profileUrl) return null;

  // Normalise to linkedin.com canonical URL
  let normUrl: string;
  try {
    const u = new URL(profileUrl);
    normUrl = `${u.origin}${u.pathname}`.replace(/\/$/, "") + "/";
  } catch {
    normUrl = profileUrl;
  }

  const isCompany =
    normUrl.includes("/company/") ||
    (item.type || "").toLowerCase().includes("company");

  return {
    profileUrl: normUrl,
    type: isCompany ? "company" : "person",
    name: item.fullName || item.name || item.firstName
      ? `${item.firstName || ""} ${item.lastName || ""}`.trim() || item.fullName
      : null,
    headline: item.headline || item.title || item.jobTitle || null,
    company: item.companyName || item.currentCompany || item.organization || null,
    location: item.location || item.addressWithCountry || null,
    about: item.summary || item.about || item.description || null,
    email: item.email || item.emailAddress || null,
    phone: item.phone || item.phoneNumber || null,
    website: item.websiteUrl || item.website || item.companyWebsite || null,
    connectionCount: item.connectionsCount || item.connections || null,
    followerCount: item.followersCount || item.followers || null,
    source: "linkedin" as const,
  };
}

// ─── Build search URLs for the actor ─────────────────────────────────────────

function buildSearchUrls(input: ApifyLinkedinInput): string[] {
  const { keyword, location, searchType = "people", jobTitles = [], targetAudiences = [] } = input;
  const loc = location ? ` ${location}` : "";
  const urls: string[] = [];

  if (searchType === "people" || searchType === "both") {
    // Primary people search
    const base = encodeURIComponent(`${keyword}${loc}`);
    urls.push(`https://www.linkedin.com/search/results/people/?keywords=${base}`);

    // Job title variants (max 3 to limit cost)
    const titles = [...jobTitles, ...targetAudiences].slice(0, 3);
    for (const title of titles) {
      const q = encodeURIComponent(`${title}${loc}`);
      urls.push(`https://www.linkedin.com/search/results/people/?keywords=${q}`);
    }
  }

  if (searchType === "company" || searchType === "both") {
    const base = encodeURIComponent(`${keyword}${loc}`);
    urls.push(`https://www.linkedin.com/search/results/companies/?keywords=${base}`);
  }

  return [...new Set(urls)]; // deduplicate
}

// ─── Exported main function ───────────────────────────────────────────────────

export async function discoverLinkedinProfilesViaApify(
  input: ApifyLinkedinInput
): Promise<LinkedinEnrichedProfile[]> {
  const apiToken = process.env.APIFY_API_TOKEN;
  if (!apiToken) {
    throw new ProviderError(ProviderErrorType.UNAUTHORIZED, "APIFY_API_TOKEN is not configured");
  }

  const { maxResults = 25 } = input;
  const startUrls = buildSearchUrls(input);

  // linkedin-profile-scraper actor input
  const actorInput: Record<string, unknown> = {
    startUrls: startUrls.map((url) => ({ url })),
    maxResults,
    scrapePersonalData: true,   // email, phone, website
    proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
  };

  console.log(`[LinkedIn/Apify] Starting actor with ${startUrls.length} search URLs, max ${maxResults} results`);

  const runId = await startRun(apiToken, ACTOR_ID, actorInput);
  console.log(`[LinkedIn/Apify] Run started: ${runId}`);

  const datasetId = await waitForRun(apiToken, runId);
  console.log(`[LinkedIn/Apify] Run succeeded, dataset: ${datasetId}`);

  const items = await fetchDataset(apiToken, datasetId);
  console.log(`[LinkedIn/Apify] Fetched ${items.length} raw items`);

  const seen = new Set<string>();
  const profiles: LinkedinEnrichedProfile[] = [];

  for (const item of items) {
    const profile = mapToLinkedinProfile(item);
    if (!profile || seen.has(profile.profileUrl)) continue;
    seen.add(profile.profileUrl);
    profiles.push(profile);
    if (profiles.length >= maxResults) break;
  }

  console.log(`[LinkedIn/Apify] ${profiles.length} unique profiles after dedup`);

  if (profiles.length === 0) {
    throw new ProviderError(ProviderErrorType.EMPTY_RESULT, "Apify returned no LinkedIn profiles");
  }

  return profiles;
}
