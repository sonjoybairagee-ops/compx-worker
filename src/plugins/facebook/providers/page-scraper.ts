/**
 * plugins/facebook/providers/page-scraper.ts
 *
 * Scrapes public Facebook Business Pages WITHOUT login.
 * Facebook public pages are accessible anonymously — no session needed.
 * This avoids the severe account-ban risk of logged-in scraping.
 *
 * Visits the /about section of each page URL to extract:
 *   - Phone, Email, Website, Address, Hours, Category, Rating
 *
 * Uses residential proxy (passed from worker) for all requests.
 * Rate limiting: 4-8s between pages, 20-40s cool-down every 10 pages.
 */
import type { Browser, BrowserContext, Page } from "playwright";
import { createContext } from "@compx/scraper-core";

export interface FacebookPageData {
  pageUrl: string;
  pageSlug: string;
  name: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
  category: string | null;
  rating: number | null;
  reviewCount: number | null;
  followersCount: number | null;
  about: string | null;
}

const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
// FIX: previously hardcoded to Bangladesh number shapes (`880`/`1[3-9]`
// prefix). Generalized to a country-agnostic international-leaning
// pattern (optional `+`, 8-15 digits, common separators) so international
// Facebook business pages aren't silently missed. Same fix already
// applied to the LinkedIn scraper's phone extraction.
const PHONE_REGEX = /\+?\d[\d\s().-]{7,17}\d/g;

async function safeText(page: Page, selector: string, timeout = 3000): Promise<string> {
  try {
    const el = page.locator(selector).first();
    await el.waitFor({ timeout, state: "visible" });
    return (await el.innerText()).trim();
  } catch {
    return "";
  }
}

async function safeAttr(page: Page, selector: string, attr: string, timeout = 3000): Promise<string | null> {
  try {
    const el = page.locator(selector).first();
    await el.waitFor({ timeout, state: "visible" });
    return await el.getAttribute(attr);
  } catch {
    return null;
  }
}

/** Extract all data from a Facebook /about page. */
async function extractPageData(page: Page, pageUrl: string): Promise<FacebookPageData> {
  const pageSlug = pageUrl.replace(/\/$/, "").split("/").pop() || "";

  // Name from og:title (most stable)
  const name = await page.evaluate(() => {
    const og = document.querySelector('meta[property="og:title"]');
    return og?.getAttribute("content")?.replace(/\s*[-|]\s*Facebook.*$/i, "").trim() || "";
  }).catch(() => "") || await safeText(page, 'h1', 3000) || pageSlug;

  // All page text for regex fallbacks
  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");

  // Phone — tel: link first, then regex on body
  const telHref = await safeAttr(page, 'a[href^="tel:"]', "href", 3000);
  let phone: string | null = telHref ? telHref.replace("tel:", "").trim() : null;
  if (!phone) {
    const matches = bodyText.match(PHONE_REGEX);
    phone = matches?.[0]?.trim() || null;
  }

  // Email — mailto: link first, then regex
  const mailHref = await safeAttr(page, 'a[href^="mailto:"]', "href", 3000);
  let email: string | null = mailHref ? mailHref.replace("mailto:", "").trim() : null;
  if (!email) {
    const matches = bodyText.match(EMAIL_REGEX);
    // filter out fb/meta internal emails
    const filtered = matches?.filter(e => !e.includes("facebook.com") && !e.includes("meta.com"));
    email = filtered?.[0] || null;
  }

  // Website — external link that's not facebook/instagram/etc
  const IGNORE_DOMAINS = ["facebook.com", "instagram.com", "youtube.com", "twitter.com", "x.com", "tiktok.com", "linkedin.com", "fb.me", "bit.ly"];
  let website: string | null = null;
  try {
    const extLinks = await page.locator('a[href^="http"]:not([href*="facebook.com"]):not([href*="fb.com"])').all();
    for (const link of extLinks.slice(0, 20)) {
      const href = await link.getAttribute("href").catch(() => null);
      if (!href) continue;
      const lower = href.toLowerCase();
      if (IGNORE_DOMAINS.some(d => lower.includes(d))) continue;
      if (lower.includes("//l.facebook.com/")) {
        // Facebook redirect link — extract actual URL
        const match = href.match(/[?&]u=([^&]+)/);
        if (match) {
          website = decodeURIComponent(match[1]);
          break;
        }
      } else {
        website = href.split("?")[0]; // strip tracking params
        break;
      }
    }
  } catch {}

  // Address
  let address: string | null = null;
  const addressEl = await safeText(page, '[data-testid="address-link"], a[href*="maps.google"]', 3000);
  if (addressEl) address = addressEl;

  // Category
  let category: string | null = null;
  try {
    // Facebook often shows category near the page name
    const catEl = await page.locator('a[href*="category"]').first().innerText({ timeout: 3000 });
    if (catEl && catEl.length < 60) category = catEl.trim();
  } catch {}

  // Rating
  let rating: number | null = null;
  let reviewCount: number | null = null;
  try {
    const ratingText = await safeText(page, '[data-testid="rating"], .x1anpbxc', 2000);
    const rMatch = ratingText.match(/(\d+\.?\d*)\s*(?:out of|\/)\s*5/i) || ratingText.match(/^(\d+\.?\d*)$/);
    if (rMatch) rating = parseFloat(rMatch[1]);

    const reviewText = await safeText(page, '[data-testid="review-count"]', 2000);
    const rvMatch = reviewText.match(/(\d[\d,]*)/);
    if (rvMatch) reviewCount = parseInt(rvMatch[1].replace(/,/g, ""));
  } catch {}

  // Followers count from og:description or body
  let followersCount: number | null = null;
  try {
    const ogDesc = await page.evaluate(() => {
      const el = document.querySelector('meta[property="og:description"]');
      return el?.getAttribute("content") || "";
    });
    const fMatch = (ogDesc + " " + bodyText.substring(0, 500)).match(/([\d.,]+[KMBkmb]?)\s*(?:followers|likes)/i);
    if (fMatch) {
      const raw = fMatch[1].replace(/,/g, "");
      const mult = /k/i.test(raw) ? 1_000 : /m/i.test(raw) ? 1_000_000 : 1;
      const n = parseFloat(raw.replace(/[kmb]/gi, ""));
      if (!isNaN(n)) followersCount = Math.round(n * mult);
    }
  } catch {}

  // About text — og:description is cleanest
  const about = await page.evaluate(() => {
    const el = document.querySelector('meta[name="description"], meta[property="og:description"]');
    return el?.getAttribute("content") || "";
  }).catch(() => "") || bodyText.substring(0, 500);

  return {
    pageUrl,
    pageSlug,
    name: name || pageSlug,
    phone,
    email,
    website,
    address,
    category,
    rating,
    reviewCount,
    followersCount,
    about: about || null,
  };
}

export interface PageScraperOptions {
  proxy?: any;
  maxPages?: number;
  onProgress?: (done: number, total: number, data: FacebookPageData) => void;
}

/**
 * Main entry: visits the /about page of each Facebook page URL and returns enriched data.
 * Creates a fresh anonymous browser context (no login) for each batch.
 */
export async function scrapePublicFacebookPages(
  browser: Browser,
  pageUrls: string[],
  opts: PageScraperOptions = {}
): Promise<FacebookPageData[]> {
  const { proxy, maxPages = 50, onProgress } = opts;
  const targets = pageUrls.slice(0, maxPages);

  // Anonymous context — no stored session, just residential proxy + stealth
  const context: BrowserContext = await createContext(browser, {
    proxy,
    platform: "generic",
    blockMedia: true,
  });

  const page = await context.newPage();
  const results: FacebookPageData[] = [];

  try {
    for (let i = 0; i < targets.length; i++) {
      const rawUrl = targets[i];

      // Always visit /about for structured contact data
      const aboutUrl = rawUrl.replace(/\/$/, "") + "/about";

      try {
        console.log(`[FacebookScraper] Visiting ${aboutUrl} (${i + 1}/${targets.length})`);

        await page.goto(aboutUrl, { waitUntil: "domcontentloaded", timeout: 25_000 });
        await page.waitForTimeout(2_000 + Math.random() * 1_500);

        // Check if Facebook redirected to login (shouldn't happen for public pages)
        const currentUrl = page.url();
        if (currentUrl.includes("/login") || currentUrl.includes("checkpoint")) {
          console.warn(`[FacebookScraper] Redirected to login at ${rawUrl} — skipping`);
        } else {
          await page.waitForSelector('main, [role="main"]', { timeout: 8_000 }).catch(() => {});

          const data = await extractPageData(page, rawUrl);
          results.push(data);

          console.log(
            `[FacebookScraper] ✅ ${data.name} — ` +
            `phone: ${data.phone ?? "none"}, ` +
            `email: ${data.email ?? "none"}, ` +
            `website: ${data.website ?? "none"}`
          );

          onProgress?.(i + 1, targets.length, data);
        }
      } catch (err: any) {
        console.warn(`[FacebookScraper] ⚠️ Failed ${rawUrl}: ${err.message}`);
      }

      // FIX: this rate-limiting block used to be skipped entirely whenever
      // a page failed, because the catch block above did `continue` and
      // jumped straight past it. That meant the exact moment something
      // was going wrong (Facebook returning an error, a redirect to
      // login/checkpoint, a timeout — all plausible signs of being
      // rate-limited or flagged) was also the moment we hammered the next
      // request with zero delay, which is the opposite of what you want.
      // The delay now always runs, success or failure, by not using
      // `continue` above.
      const delay = 4_000 + Math.random() * 4_000;
      const cooldown = (i + 1) % 10 === 0 ? 20_000 + Math.random() * 20_000 : 0;
      if (cooldown > 0) {
        console.log(`[FacebookScraper] Cool-down after ${i + 1} pages (${Math.round((delay + cooldown) / 1000)}s)`);
      }
      await page.waitForTimeout(delay + cooldown);
    }
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }

  return results;
}
