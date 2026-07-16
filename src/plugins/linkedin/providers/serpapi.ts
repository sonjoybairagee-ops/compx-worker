/**
 * plugins/linkedin/providers/serpapi.ts
 *
 * Discovers LinkedIn profile & company URLs via Google (SerpAPI).
 * Returns two lists: personal profiles (/in/) and company pages (/company/).
 *
 * This is the safest first step — no session, no browser, no ban risk.
 * The returned URLs are then passed to the profile scraper for full enrichment.
 */
import { ProviderError, ProviderErrorType } from "@compx/scraper-core";

export interface LinkedinDiscoveryInput {
  keyword: string;
  location?: string;
  maxResults?: number;
  searchType?: "people" | "company" | "both";
}

export interface LinkedinProfileStub {
  profileUrl: string;
  name: string;
  headline: string;
  type: "person" | "company";
  snippet: string;
}

const IGNORE_LI_PATHS = new Set([
  "jobs", "feed", "messaging", "notifications", "login", "signup",
  "help", "legal", "about", "pulse", "learning", "talent", "sales",
  "posts", "groups", "events", "search",
]);

function isPersonUrl(url: string) {
  return url.includes("/in/") && !url.includes("/posts/") && !url.includes("/recent-activity/");
}

function isCompanyUrl(url: string) {
  return url.includes("/company/") && !url.includes("/jobs/") && !url.includes("/posts/");
}

function parseStub(result: any, type: "person" | "company"): LinkedinProfileStub | null {
  if (!result.link?.includes("linkedin.com/")) return null;

  try { new URL(result.link); } catch { return null; }

  const isValid = type === "person" ? isPersonUrl(result.link) : isCompanyUrl(result.link);
  if (!isValid) return null;

  // Check for ignored paths
  const pathParts = new URL(result.link).pathname.split("/").filter(Boolean);
  if (pathParts.some(p => IGNORE_LI_PATHS.has(p.toLowerCase()))) return null;

  const snippet = result.snippet || "";
  const name = result.title
    ? result.title
        .replace(/\s*[-–|]\s*LinkedIn.*$/i, "")
        .replace(/\s*\|.*$/i, "")
        .trim()
    : "";

  // Normalize URL — remove query params and trailing slashes
  let profileUrl: string;
  try {
    const u = new URL(result.link);
    profileUrl = `${u.origin}${u.pathname}`.replace(/\/$/, "") + "/";
  } catch {
    profileUrl = result.link;
  }

  return {
    profileUrl,
    name: name || profileUrl,
    headline: snippet.split("\n")[0].trim(),
    type,
    snippet,
  };
}

async function fetchSerpPage(query: string, apiKey: string, start = 0): Promise<any[]> {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("num", "50");
  if (start > 0) url.searchParams.set("start", String(start));

  const res = await fetch(url.toString());
  if (res.status === 401 || res.status === 403) throw new ProviderError(ProviderErrorType.UNAUTHORIZED, "Invalid SerpApi Key");
  if (res.status === 402) throw new ProviderError(ProviderErrorType.PAYMENT_REQUIRED, "SerpApi out of credits");
  if (res.status === 429) throw new ProviderError(ProviderErrorType.RATE_LIMIT, "SerpApi rate limited");
  if (!res.ok) throw new ProviderError(ProviderErrorType.SERVER_ERROR, `SerpApi HTTP ${res.status}`);

  const data = await res.json();
  return data.organic_results || [];
}

export async function discoverLinkedinProfilesViaSerpApi(
  input: LinkedinDiscoveryInput
): Promise<LinkedinProfileStub[]> {
  const { keyword, location, maxResults = 50, searchType = "people" } = input;
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) throw new ProviderError(ProviderErrorType.UNAUTHORIZED, "SERPAPI_API_KEY is not configured");

  const loc = location ? ` ${location}` : "";
  const stubs: LinkedinProfileStub[] = [];
  const seen = new Set<string>();

  // Query 1: People profiles
  if (searchType === "people" || searchType === "both") {
    const query = `site:linkedin.com/in "${keyword}"${loc}`;
    const pages = maxResults > 50 ? [0, 50] : [0];

    for (const start of pages) {
      try {
        const raw = await fetchSerpPage(query, apiKey, start);
        for (const r of raw) {
          const stub = parseStub(r, "person");
          if (stub && !seen.has(stub.profileUrl)) {
            seen.add(stub.profileUrl);
            stubs.push(stub);
            if (stubs.length >= maxResults) break;
          }
        }
      } catch (e: any) {
        if (start > 0) break;
        throw e;
      }
      if (stubs.length >= maxResults) break;
    }
  }

  // Query 2: Company pages (if requested and we still have room)
  if ((searchType === "company" || searchType === "both") && stubs.length < maxResults) {
    const query = `site:linkedin.com/company "${keyword}"${loc}`;
    const remaining = maxResults - stubs.length;

    try {
      const raw = await fetchSerpPage(query, apiKey);
      for (const r of raw) {
        const stub = parseStub(r, "company");
        if (stub && !seen.has(stub.profileUrl)) {
          seen.add(stub.profileUrl);
          stubs.push(stub);
          if (stubs.length >= maxResults || stubs.filter(s => s.type === "company").length >= remaining) break;
        }
      }
    } catch {
      // company search failure is non-fatal
    }
  }

  if (stubs.length === 0) {
    throw new ProviderError(ProviderErrorType.EMPTY_RESULT, "No LinkedIn profiles found via SerpApi");
  }

  console.log(`[LinkedIn SerpAPI] Found: ${stubs.filter(s => s.type === "person").length} people, ${stubs.filter(s => s.type === "company").length} companies`);
  return stubs;
}
