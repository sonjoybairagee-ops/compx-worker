/**
 * plugins/instagram/providers/serpapi.ts
 *
 * Uses Google (via SerpAPI) to discover Instagram profiles matching a keyword.
 * This is the safest discovery method — no session or browser needed.
 * Returns a list of partially-enriched profile stubs (username, name, bio, follower count from snippet).
 * These stubs are then passed to the profile-enrichment scraper for full data.
 */
import { ProviderError, ProviderErrorType } from "@compx/scraper-core";
import type { ProviderRunContext } from "@compx/scraper-core";

export interface InstagramFilters {
  searchType?: string;
  followers?: string;
  industry?: string;
  businessOnly?: boolean;
  hasWebsite?: boolean;
  hasPublicEmail?: boolean;
}

export interface InstagramSerpApiInput {
  keyword: string;
  location?: string;
  maxResults?: number;
  filters?: InstagramFilters;
}

export interface SerpApiProfileStub {
  username: string;
  name: string;
  bio: string;
  followersCount: number | null;
  profileUrl: string;
  source: "serpapi";
}

const NON_USERNAME_SEGMENTS = new Set([
  "p", "reel", "reels", "tv", "stories", "explore", "accounts",
  "legal", "language", "about", "help", "api", "developer",
  "press", "directory", "privacy", "terms", "login", "signup", "web",
]);

function parseCountFromSnippet(snippet: string): number | null {
  const match = snippet.match(/(\d+(?:[.,]?\d*)?[KMBkmb]?)\s*(?:followers?)/i);
  if (!match) return null;
  const raw = match[1].replace(/[^0-9.KMBkmb]/gi, "");
  const mult = /k/i.test(raw) ? 1_000 : /m/i.test(raw) ? 1_000_000 : /b/i.test(raw) ? 1_000_000_000 : 1;
  const n = parseFloat(raw.replace(/[kmb]/gi, ""));
  return isNaN(n) ? null : Math.round(n * mult);
}

function parseResult(result: any): SerpApiProfileStub | null {
  if (!result.link?.includes("instagram.com/")) return null;

  let username: string | null = null;

  // Priority 1: from "source" field e.g. "Instagram · username"
  if (typeof result.source === "string" && result.source.includes("·")) {
    const candidate = result.source.split("·").pop()?.trim();
    if (candidate && !NON_USERNAME_SEGMENTS.has(candidate.toLowerCase())) {
      username = candidate;
    }
  }

  // Priority 2: URL parsing
  if (!username) {
    const m = result.link.match(/instagram\.com\/([^\/\?#]+)/);
    const candidate = m?.[1];
    if (candidate && !NON_USERNAME_SEGMENTS.has(candidate.toLowerCase())) {
      username = candidate;
    }
  }

  if (!username) return null;

  const snippet = result.snippet || "";
  const name = result.title
    ? result.title.replace(/\s*[-–]\s*Instagram.*$/i, "").replace(/\s*\|.*$/i, "").trim() || username
    : username;

  return {
    username,
    name,
    bio: snippet,
    followersCount: parseCountFromSnippet(snippet),
    profileUrl: `https://www.instagram.com/${username}/`,
    source: "serpapi",
  };
}

async function fetchPage(query: string, apiKey: string, start = 0): Promise<any[]> {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", `${query} site:instagram.com`);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("num", "50");
  if (start > 0) url.searchParams.set("start", String(start));

  const res = await fetch(url.toString());
  if (res.status === 401 || res.status === 403) throw new ProviderError(ProviderErrorType.UNAUTHORIZED, "Invalid SerpApi Key");
  if (res.status === 402) throw new ProviderError(ProviderErrorType.PAYMENT_REQUIRED, "SerpApi out of credits");
  if (res.status === 429) throw new ProviderError(ProviderErrorType.RATE_LIMIT, "SerpApi rate limit exceeded");
  if (!res.ok) throw new ProviderError(ProviderErrorType.SERVER_ERROR, `SerpApi HTTP ${res.status}`);

  const data = await res.json();
  return data.organic_results || [];
}

export async function discoverUsernamesViaSerpApi(
  input: InstagramSerpApiInput,
  _ctx?: ProviderRunContext
): Promise<SerpApiProfileStub[]> {
  const { keyword, location, filters = {}, maxResults = 50 } = input;
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) throw new ProviderError(ProviderErrorType.UNAUTHORIZED, "SERPAPI_API_KEY is not configured");

  // Build targeted query
  const queryParts = [keyword];
  if (location) queryParts.push(location);
  if (filters.industry?.trim()) queryParts.push(filters.industry.trim());
  if (filters.businessOnly) queryParts.push("business");
  const query = queryParts.join(" ");

  const seen = new Set<string>();
  const stubs: SerpApiProfileStub[] = [];

  // Fetch up to 2 pages (100 results) from Google
  const pages = maxResults > 50 ? [0, 50] : [0];
  for (const start of pages) {
    try {
      const raw = await fetchPage(query, apiKey, start);
      for (const r of raw) {
        const stub = parseResult(r);
        if (stub && !seen.has(stub.username)) {
          seen.add(stub.username);
          stubs.push(stub);
          if (stubs.length >= maxResults) break;
        }
      }
    } catch (e: any) {
      if (start > 0) break; // page 2 failure is non-fatal
      throw e;
    }
    if (stubs.length >= maxResults) break;
  }

  if (stubs.length === 0) throw new ProviderError(ProviderErrorType.EMPTY_RESULT, "No Instagram profiles found via SerpApi");
  return stubs;
}
