/**
 * plugins/instagram/providers/hashtag.ts
 *
 * Discovers Instagram profiles by visiting relevant hashtag pages.
 * More reliable than keyword/explore search and less suspicious to Instagram
 * because hashtag browsing is a very common human behavior.
 *
 * Flow:
 *   keyword → generate hashtags → visit each hashtag page → collect usernames
 *
 * Uses the logged-in session + residential proxy for all browser requests.
 */
import type { Page, BrowserContext } from "playwright";
import type { SerpApiProfileStub } from "./serpapi.js";

const IGNORED_SEGMENTS = new Set([
  "p", "reel", "reels", "tv", "stories", "explore", "accounts",
  "legal", "language", "about", "help", "api", "developer",
  "press", "directory", "privacy", "terms", "login", "signup", "web",
]);

/** Generate hashtag candidates from a keyword + location. */
export function generateHashtags(keyword: string, location?: string): string[] {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

  const kw = slug(keyword);
  const loc = location ? slug(location) : "";

  const tags: string[] = [];

  // Primary: keyword alone
  tags.push(kw);
  // keyword + business
  tags.push(`${kw}business`);
  // keyword + location
  if (loc) {
    tags.push(`${kw}${loc}`);
    tags.push(`${loc}${kw}`);
    tags.push(`${loc}business`);
  }
  // Remove duplicates and empty
  return [...new Set(tags)].filter(Boolean);
}

/** Scrape a single hashtag page for profile links. */
async function scrapeHashtagPage(
  page: Page,
  hashtag: string,
  seen: Set<string>,
  maxNew: number
): Promise<SerpApiProfileStub[]> {
  const stubs: SerpApiProfileStub[] = [];
  const url = `https://www.instagram.com/explore/tags/${encodeURIComponent(hashtag)}/`;

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3_000 + Math.random() * 2_000);

    const currentUrl = page.url();
    if (currentUrl.includes("/accounts/login") || currentUrl.includes("/challenge/")) {
      console.warn(`[Hashtag] Session blocked on #${hashtag}. Stopping.`);
      return stubs; // caller will handle session invalidation
    }

    // Collect post links → then extract author usernames
    const postLinks = await page.locator('a[href*="/p/"]').all();
    const postHrefs: string[] = [];
    for (const link of postLinks.slice(0, 18)) { // look at first 18 posts
      const href = await link.getAttribute("href").catch(() => null);
      if (href) postHrefs.push(href);
    }

    // Visit each post briefly to get the author username from the header link
    for (const postHref of postHrefs) {
      if (stubs.length >= maxNew) break;

      try {
        const postUrl = postHref.startsWith("http")
          ? postHref
          : `https://www.instagram.com${postHref}`;

        console.log(`[Hashtag]   -> Checking post ${stubs.length + 1}/${maxNew} for #${hashtag}...`);
        await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
        await page.waitForTimeout(1_500 + Math.random() * 1_000);

        // Author link is the <a> that points to a username in the post header
        const authorLinks = await page.locator('header a[href^="/"]').all();
        for (const link of authorLinks) {
          const href = await link.getAttribute("href").catch(() => null);
          if (!href) continue;
          const username = href.split("/").filter(Boolean)[0];
          if (!username || IGNORED_SEGMENTS.has(username) || seen.has(username)) continue;

          seen.add(username);
          stubs.push({
            username,
            name: username,
            bio: "",
            followersCount: null,
            profileUrl: `https://www.instagram.com/${username}/`,
            source: "serpapi", // reuse type, mark as discovered
          });
          break; // one author per post
        }
      } catch {
        // individual post failure is non-fatal
        continue;
      }

      await page.waitForTimeout(2_000 + Math.random() * 1_500);
    }
  } catch (e: any) {
    console.warn(`[Hashtag] Failed to scrape #${hashtag}: ${e.message}`);
  }

  return stubs;
}

export interface HashtagDiscoveryInput {
  keyword: string;
  location?: string;
  maxResults?: number;
}

/**
 * Main entry: discover Instagram usernames via hashtag pages.
 * Requires an active Playwright BrowserContext with session + proxy loaded.
 */
export async function discoverUsernamesViaHashtags(
  context: BrowserContext,
  input: HashtagDiscoveryInput,
  alreadySeen: Set<string>
): Promise<SerpApiProfileStub[]> {
  const { keyword, location, maxResults = 30 } = input;

  const hashtags = generateHashtags(keyword, location);
  console.log(`[Hashtag] Trying hashtags: ${hashtags.map(h => `#${h}`).join(", ")}`);

  const page = await context.newPage();
  const collected: SerpApiProfileStub[] = [];
  const seen = new Set<string>(alreadySeen);

  try {
    for (const tag of hashtags) {
      if (collected.length >= maxResults) break;
      const remaining = maxResults - collected.length;
      const newStubs = await scrapeHashtagPage(page, tag, seen, remaining);
      collected.push(...newStubs);
      console.log(`[Hashtag] #${tag} → ${newStubs.length} new usernames (total: ${collected.length})`);

      // Pause between hashtag pages — looks more human
      if (hashtags.indexOf(tag) < hashtags.length - 1) {
        await page.waitForTimeout(5_000 + Math.random() * 5_000);
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  return collected;
}
