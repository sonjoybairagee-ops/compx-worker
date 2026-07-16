/**
 * plugins/linkedin/providers/search-scraper.ts
 *
 * Discovers LinkedIn profiles by searching directly on LinkedIn.com
 * using a logged-in session. This is the only reliable way to get
 * LinkedIn profile URLs — SerpAPI/Google indexing is blocked by LinkedIn.
 *
 * Searches:
 *   - /search/results/people/ for individual profiles
 *   - /search/results/companies/ for company pages
 *
 * Returns a list of profile URLs + basic info from search result cards.
 * Full enrichment (email, phone) is done by profile-scraper.ts afterward.
 */
import type { BrowserContext, Page } from "playwright";

export interface LinkedinSearchInput {
  keyword: string;
  location?: string;
  searchType?: "people" | "company" | "both";
  jobTitles?: string[];       // from UI filters
  targetAudiences?: string[];  // from UI filters
  maxResults?: number;
}

export interface LinkedinSearchStub {
  profileUrl: string;
  type: "person" | "company";
  name: string;
  headline: string;
  location: string;
}

// LinkedIn geo URN map for common locations
// Full list: https://www.linkedin.com/help/linkedin/answer/a564073
const GEO_URNS: Record<string, string> = {
  "bangladesh":      "103323279",
  "dhaka":           "105556691",
  "chittagong":      "105247083",
  "india":           "102713980",
  "usa":             "103644278",
  "united states":   "103644278",
  "uk":              "101165590",
  "united kingdom":  "101165590",
  "canada":          "101174742",
  "australia":       "101452733",
  "singapore":       "102454443",
  "uae":             "104305776",
};

function getGeoUrn(location?: string): string | null {
  if (!location) return null;
  const key = location.toLowerCase().trim();
  return GEO_URNS[key] || null;
}

/** Build LinkedIn people search URL */
function buildPeopleSearchUrl(keyword: string, location?: string, page = 1): string {
  const params = new URLSearchParams();
  params.set("keywords", keyword);
  params.set("origin", "GLOBAL_SEARCH_HEADER");
  if (page > 1) params.set("start", String((page - 1) * 10));

  const geoUrn = getGeoUrn(location);
  if (geoUrn) {
    params.set("geoUrn", `["${geoUrn}"]`);
  }

  return `https://www.linkedin.com/search/results/people/?${params.toString()}`;
}

/** Build LinkedIn company search URL */
function buildCompanySearchUrl(keyword: string, location?: string, page = 1): string {
  const params = new URLSearchParams();
  params.set("keywords", keyword);
  params.set("origin", "GLOBAL_SEARCH_HEADER");
  if (page > 1) params.set("start", String((page - 1) * 10));

  return `https://www.linkedin.com/search/results/companies/?${params.toString()}`;
}

// FIX: extractPeopleResults() and extractCompanyResults() were almost
// entirely duplicated (same wait, same waitForSelector, same card-loop
// shape) — any future selector fix (LinkedIn changes these often) had to
// be applied twice, with an easy chance of only remembering one. Merged
// into a single helper parameterized by result type. This also fixes a
// small gap: extractCompanyResults() never actually read a location for
// company cards (always pushed `location: ""`), even though LinkedIn's
// company search cards do show industry/location text in the same
// secondary-subtitle slot people cards use.
async function extractSearchResults(
  page: Page,
  kind: "person" | "company"
): Promise<LinkedinSearchStub[]> {
  await page.waitForTimeout(2_500 + Math.random() * 1_500);

  const stubs: LinkedinSearchStub[] = [];

  try {
    await page.waitForSelector('.reusable-search__result-container, .entity-result', {
      timeout: 15_000,
    });
  } catch {
    return stubs; // no results or timeout
  }

  const linkPattern = kind === "person" ? '/in/' : '/company/';
  const urlRegex = kind === "person" ? /(\/in\/[^/?#]+)/ : /(\/company\/[^/?#]+)/;

  const cards = await page.locator('.reusable-search__result-container, .entity-result__item').all();

  for (const card of cards) {
    try {
      const linkEl = card.locator(`a[href*="${linkPattern}"]`).first();
      const href = await linkEl.getAttribute("href").catch(() => null);
      if (!href) continue;

      const match = href.match(urlRegex);
      if (!match) continue;
      const profileUrl = `https://www.linkedin.com${match[1]}/`;

      const name = await card.locator('.entity-result__title-text a span[aria-hidden="true"], .app-aware-link span[aria-hidden="true"]')
        .first().innerText().catch(() => "");

      const headline = await card.locator('.entity-result__primary-subtitle, .entity-result__summary')
        .first().innerText().catch(() => "");

      const location = await card.locator('.entity-result__secondary-subtitle')
        .first().innerText().catch(() => "");

      stubs.push({
        profileUrl,
        type: kind,
        name: name.trim() || profileUrl,
        headline: headline.trim(),
        location: location.trim(),
      });
    } catch {
      continue;
    }
  }

  return stubs;
}

/**
 * Main entry: search LinkedIn directly using logged-in session.
 * Builds multiple search queries from keyword + UI filters.
 */
export async function searchLinkedInProfiles(
  context: BrowserContext,
  input: LinkedinSearchInput
): Promise<LinkedinSearchStub[]> {
  const {
    keyword,
    location,
    searchType = "people",
    jobTitles = [],
    targetAudiences = [],
    maxResults = 50,
  } = input;

  // Build search terms: keyword + each job title filter
  const searchTerms = new Set<string>();
  searchTerms.add(keyword);

  // Add job titles as separate search terms (max 4 extra)
  const extraTerms = [...jobTitles, ...targetAudiences].slice(0, 4);
  for (const term of extraTerms) {
    searchTerms.add(term);
  }

  const page = await context.newPage();
  const seen = new Set<string>();
  const allStubs: LinkedinSearchStub[] = [];

  try {
    for (const term of searchTerms) {
      if (allStubs.length >= maxResults) break;

      const remaining = maxResults - allStubs.length;
      const pagesNeeded = Math.ceil(Math.min(remaining, 30) / 10); // 10 results per page

      // People search
      if (searchType === "people" || searchType === "both") {
        for (let p = 1; p <= Math.min(pagesNeeded, 3); p++) {
          if (allStubs.length >= maxResults) break;

          const url = buildPeopleSearchUrl(term, location, p);
          console.log(`[LinkedIn Search] People: "${term}" page ${p} → ${url}`);

          try {
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

            // Check for login wall
            const currentUrl = page.url();
            if (currentUrl.includes("/login") || currentUrl.includes("/authwall")) {
              console.warn("[LinkedIn Search] Session expired — hit login wall");
              throw new Error("LINKEDIN_SESSION_BLOCKED");
            }

            const stubs = await extractSearchResults(page, "person");
            for (const stub of stubs) {
              if (!seen.has(stub.profileUrl)) {
                seen.add(stub.profileUrl);
                allStubs.push(stub);
              }
            }

            console.log(`[LinkedIn Search] Got ${stubs.length} results (total: ${allStubs.length})`);

            // Pause between pages — human-like
            if (p < pagesNeeded) {
              await page.waitForTimeout(4_000 + Math.random() * 3_000);
            }
          } catch (e: any) {
            if (e.message?.includes("LINKEDIN_SESSION_BLOCKED")) throw e;
            console.warn(`[LinkedIn Search] Page ${p} failed: ${e.message}`);
            break;
          }
        }
      }

      // Company search
      if (searchType === "company" || searchType === "both") {
        for (let p = 1; p <= Math.min(pagesNeeded, 2); p++) {
          if (allStubs.length >= maxResults) break;

          const url = buildCompanySearchUrl(term, location, p);
          console.log(`[LinkedIn Search] Companies: "${term}" page ${p}`);

          try {
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

            const currentUrl = page.url();
            if (currentUrl.includes("/login") || currentUrl.includes("/authwall")) {
              throw new Error("LINKEDIN_SESSION_BLOCKED");
            }

            const stubs = await extractSearchResults(page, "company");
            for (const stub of stubs) {
              if (!seen.has(stub.profileUrl)) {
                seen.add(stub.profileUrl);
                allStubs.push(stub);
              }
            }

            if (p < pagesNeeded) {
              await page.waitForTimeout(4_000 + Math.random() * 3_000);
            }
          } catch (e: any) {
            if (e.message?.includes("LINKEDIN_SESSION_BLOCKED")) throw e;
            console.warn(`[LinkedIn Search] Company page ${p} failed: ${e.message}`);
            break;
          }
        }
      }

      // Pause between search terms
      if (searchTerms.size > 1) {
        await page.waitForTimeout(5_000 + Math.random() * 5_000);
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  console.log(`[LinkedIn Search] Total unique profiles found: ${allStubs.length}`);
  return allStubs;
}
