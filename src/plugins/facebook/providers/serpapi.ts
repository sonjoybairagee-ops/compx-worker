/**
 * plugins/facebook/providers/serpapi.ts
 *
 * Discovers Facebook Business Page URLs via Google (SerpAPI).
 * Returns structured stubs with page URL + partial data from snippet.
 * Full enrichment (phone, email, website) is done by page-scraper.ts.
 */
import { ProviderError, ProviderErrorType } from "@compx/scraper-core";

export interface FacebookProviderInput {
  keyword: string;
  location?: string;
  maxResults?: number;
}

export interface FacebookPageStub {
  pageUrl: string;
  pageSlug: string;
  name: string;
  about: string;
  followersCount: number | null;
  category: string | null;
  website: string | null;
  phone: string | null;
}

const IGNORE_FB_PATHS = new Set([
  "watch", "marketplace", "gaming", "groups", "events", "stories",
  "ads", "business", "help", "policies", "legal", "login", "signup",
  "privacy", "settings", "profile.php",
]);

const IGNORE_DOMAINS = [
  "facebook.com", "instagram.com", "youtube.com", "twitter.com",
  "x.com", "tiktok.com", "linkedin.com",
];

function parseCount(s: string): number | null {
  const raw = s.replace(/,/g, "");
  const mult = /k/i.test(raw) ? 1_000 : /m/i.test(raw) ? 1_000_000 : /b/i.test(raw) ? 1_000_000_000 : 1;
  const n = parseFloat(raw.replace(/[kmb]/gi, ""));
  return isNaN(n) ? null : Math.round(n * mult);
}

function parseStub(result: any): FacebookPageStub | null {
  if (!result.link?.includes("facebook.com/")) return null;

  let urlObj: URL;
  try { urlObj = new URL(result.link); } catch { return null; }

  const pathParts = urlObj.pathname.replace(/\/$/, "").split("/").filter(Boolean);
  const pageSlug = pathParts[pathParts.length - 1] || "";

  if (!pageSlug || IGNORE_FB_PATHS.has(pageSlug.toLowerCase())) return null;

  // Must look like a page (has path segment after facebook.com)
  if (pathParts.length < 1) return null;

  const snippet = result.snippet || "";

  // Name
  const name = result.title
    ? result.title.replace(/\s*[|\-–]\s*Facebook.*$/i, "").replace(/\s*-\s*Home\s*$/i, "").trim()
    : pageSlug;

  // Followers
  let followersCount: number | null = null;
  const statsText = `${result.displayed_link || ""} ${snippet}`;
  const statsMatch = statsText.match(/([\d.,]+[KMBkmb]?)\+?\s*(?:likes|followers)/i);
  if (statsMatch) followersCount = parseCount(statsMatch[1]);

  // Category
  let category: string | null = null;
  const catMatch = snippet.match(/^([A-Za-z &\/]+?)\s*[·•|]\s/) || result.title?.match(/\(([^)]+)\)/);
  if (catMatch) {
    const cat = catMatch[1].trim();
    if (cat.length > 3 && cat.length < 60 && !/facebook/i.test(cat)) category = cat;
  }

  // Website from snippet
  let website: string | null = null;
  const domainRegex = /(?:https?:\/\/)?(?:www\.)?([-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_+.~#?&//=]*))/gi;
  const domainMatches = snippet.match(domainRegex);
  if (domainMatches) {
    const valid = domainMatches.find(d => {
      const clean = d.replace(/^https?:\/\//, "").replace(/^www\./, "").toLowerCase();
      return !IGNORE_DOMAINS.some(ig => clean.includes(ig));
    });
    if (valid) website = (valid.startsWith("http") ? valid : `https://${valid}`).replace(/[.,;]$/, "");
  }

  // Phone from snippet
  let phone: string | null = null;
  const phoneMatch = snippet.match(/(?:\+?880[-\s]?|0)?(?:1[3-9]\d{8}|\d{2,4}[-\s]\d{3,4}[-\s]\d{3,4})/);
  if (phoneMatch) phone = phoneMatch[0].trim();

  return {
    pageUrl: `https://www.facebook.com/${pageSlug}/`,
    pageSlug,
    name: name || pageSlug,
    about: snippet,
    followersCount,
    category,
    website,
    phone,
  };
}

async function fetchPage(query: string, apiKey: string, start = 0): Promise<any[]> {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", `${query} site:facebook.com`);
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

export async function discoverFacebookPagesViaSerpApi(
  input: FacebookProviderInput
): Promise<FacebookPageStub[]> {
  const { keyword, location, maxResults = 50 } = input;
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) throw new ProviderError(ProviderErrorType.UNAUTHORIZED, "SERPAPI_API_KEY is not configured");

  const query = location ? `${keyword} ${location}` : keyword;

  const seen = new Set<string>();
  const stubs: FacebookPageStub[] = [];
  const pages = maxResults > 50 ? [0, 50] : [0];

  for (const start of pages) {
    try {
      const raw = await fetchPage(query, apiKey, start);
      for (const r of raw) {
        const stub = parseStub(r);
        if (stub && !seen.has(stub.pageSlug)) {
          seen.add(stub.pageSlug);
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

  if (stubs.length === 0) throw new ProviderError(ProviderErrorType.EMPTY_RESULT, "No Facebook pages found via SerpApi");
  return stubs;
}
