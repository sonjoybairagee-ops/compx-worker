/**
 * plugins/instagram/providers/profile-enricher.ts
 *
 * Deep-enriches a list of Instagram usernames by visiting each profile page.
 * Extracts: bio, email, phone, website, category, follower/following/post counts.
 *
 * Uses stable selectors (href, meta tags, aria-label) rather than fragile
 * dynamic class names — Instagram changes classes frequently but these attributes
 * remain consistent across redesigns.
 *
 * Rate limiting strategy:
 *  - 3-7 second random delay between profiles
 *  - 15-30 second cool-down after every 10 profiles
 *  - Human-like pause before extracting data
 */
import type { BrowserContext, Page } from "playwright";

export interface EnrichedProfile {
  username: string;
  name: string;
  bio: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  category: string | null;
  followersCount: number | null;
  followingCount: number | null;
  postsCount: number | null;
  isVerified: boolean;
  isBusiness: boolean;
  profileUrl: string;
  source: "instagram";
}

const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_REGEX = /(?:\+?[\d\s\-().]{7,20})/g;

function parseFollowerCount(text: string): number | null {
  if (!text) return null;
  const clean = text.replace(/,/g, "").trim();
  const match = clean.match(/^([\d.]+)\s*([KMBkmb])?/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  const mult = match[2]
    ? /k/i.test(match[2]) ? 1_000 : /m/i.test(match[2]) ? 1_000_000 : 1_000_000_000
    : 1;
  return isNaN(num) ? null : Math.round(num * mult);
}

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

/**
 * Extract structured data from an Instagram profile page.
 * The page must already be navigated to the profile URL.
 */
async function extractProfileData(page: Page, username: string): Promise<EnrichedProfile> {
  // --- Strategy 1: JSON-LD / meta tags (most stable) ---
  let metaBio = "";
  try {
    metaBio = await page.evaluate(() => {
      const desc = document.querySelector('meta[name="description"]');
      return desc?.getAttribute("content") || "";
    });
  } catch {}

  // --- Strategy 2: Direct DOM extraction ---
  // FIX: previously waited another 1.5-2.5s here on top of the identical
  // wait the caller (enrichProfiles' main loop) already does right after
  // goto()/waitForSelector('main') — both waits existed for the same
  // "let the page settle" reason, so this was pure dead time stacked on
  // top of the first wait, costing ~1.5-2.5s per profile for nothing
  // (50 profiles ≈ 1-2 extra minutes with zero benefit). The caller's
  // wait already covers it before extractProfileData() is even called.

  // Bio text — the <section> that contains user info
  const bioDom = await safeText(page, '[data-testid="user-description"], ._aa_c, .x7a106z', 4000)
    || metaBio;

  // Email — explicit mailto link wins, then regex on bio
  const emailHref = await safeAttr(page, 'a[href^="mailto:"]', "href");
  let email: string | null = emailHref ? emailHref.replace("mailto:", "").trim() : null;
  if (!email && bioDom) {
    const matches = bioDom.match(EMAIL_REGEX);
    email = matches?.[0] ?? null;
  }

  // Phone — tel link wins, then regex on bio
  const phoneHref = await safeAttr(page, 'a[href^="tel:"]', "href");
  let phone: string | null = phoneHref ? phoneHref.replace("tel:", "").trim() : null;
  if (!phone && bioDom) {
    // FIX: this previously re-queried the exact same 'a[href^="tel:"]'
    // selector that had already just returned null a few lines above —
    // querying it again a moment later on the same static page returns
    // the same null, so this fallback never actually did anything. The
    // module already defines PHONE_REGEX for exactly this purpose (mirror
    // of how `email` falls back to EMAIL_REGEX on bioDom above) but it
    // was never used. Require at least 7 digits so we don't pick up
    // dates, follower counts, or other short numeric strings in the bio.
    const matches = bioDom.match(PHONE_REGEX);
    const candidate = matches?.find((m) => m.replace(/\D/g, "").length >= 7);
    phone = candidate?.trim() ?? null;
  }

  // Website — external link in bio section
  const websiteHref = await safeAttr(
    page,
    'a[rel~="nofollow"][href]:not([href*="instagram.com"]):not([href^="mailto:"]):not([href^="tel:"])',
    "href"
  );
  const website = websiteHref?.trim() || null;

  // Category (Business/Creator category label)
  const category = await safeText(
    page,
    '[data-testid="profile-meta"] span, .x1lliihq.x1plvlek span',
    3000
  ) || null;

  // Verified badge
  const isVerified = await page.locator('[aria-label="Verified"], [title="Verified"]').count()
    .then(n => n > 0).catch(() => false);

  // Business/Creator indicator
  const isBusiness = await page.evaluate(() => {
    const bodyText = document.body.innerText;
    return (
      bodyText.includes("Business") ||
      bodyText.includes("Creator") ||
      bodyText.includes("Professional account") ||
      document.querySelector('a[href^="/emails/"]') !== null
    );
  }).catch(() => false);

  // Follower / Following / Posts counts
  // Instagram renders these in <meta property="og:description"> as well
  let followersCount: number | null = null;
  let followingCount: number | null = null;
  let postsCount: number | null = null;

  try {
    const ogDesc = await page.evaluate(() => {
      const el = document.querySelector('meta[property="og:description"]');
      return el?.getAttribute("content") || "";
    });

    // Format: "1.2M Followers, 500 Following, 100 Posts"
    const fMatch = ogDesc.match(/([\d.,]+[KMBkmb]?)\s*Followers?/i);
    const ingMatch = ogDesc.match(/([\d.,]+[KMBkmb]?)\s*Following/i);
    const pMatch = ogDesc.match(/([\d.,]+[KMBkmb]?)\s*Posts?/i);

    if (fMatch) followersCount = parseFollowerCount(fMatch[1]);
    if (ingMatch) followingCount = parseFollowerCount(ingMatch[1]);
    if (pMatch) postsCount = parseFollowerCount(pMatch[1]);
  } catch {}

  // Fallback: stat from visible li elements
  if (followersCount === null) {
    try {
      const statEls = await page.locator('ul > li').all();
      for (const li of statEls) {
        const txt = await li.innerText().catch(() => "");
        if (/followers?/i.test(txt)) followersCount = parseFollowerCount(txt.split(/\s/)[0]);
        if (/following/i.test(txt)) followingCount = parseFollowerCount(txt.split(/\s/)[0]);
        if (/posts?/i.test(txt)) postsCount = parseFollowerCount(txt.split(/\s/)[0]);
      }
    } catch {}
  }

  // Name — og:title is most reliable
  const name = await page.evaluate(() => {
    const og = document.querySelector('meta[property="og:title"]');
    return og?.getAttribute("content")?.replace(/\s*[-–]\s*Instagram.*$/i, "").trim() || "";
  }).catch(() => "") || await safeText(page, 'h1, h2', 3000) || username;

  return {
    username,
    name: name || username,
    bio: bioDom || metaBio,
    email,
    phone,
    website,
    category,
    followersCount,
    followingCount,
    postsCount,
    isVerified,
    isBusiness,
    profileUrl: `https://www.instagram.com/${username}/`,
    source: "instagram",
  };
}

export interface ProfileEnricherOptions {
  maxProfiles?: number;
  onProgress?: (done: number, total: number, profile: EnrichedProfile) => void;
  onBlocked?: () => void; // called if session appears logged out
}

/**
 * Main entry: visits each username profile and returns enriched data.
 * Requires an active Playwright BrowserContext with session + proxy loaded.
 */
export async function enrichProfiles(
  context: BrowserContext,
  usernames: string[],
  opts: ProfileEnricherOptions = {}
): Promise<EnrichedProfile[]> {
  const { maxProfiles = 50, onProgress, onBlocked } = opts;
  const targets = usernames.slice(0, maxProfiles);

  const page = await context.newPage();
  const results: EnrichedProfile[] = [];

  try {
    for (let i = 0; i < targets.length; i++) {
      const username = targets[i];
      const profileUrl = `https://www.instagram.com/${username}/`;

      try {
        console.log(`[ProfileEnricher] Visiting @${username} (${i + 1}/${targets.length})`);

        await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 25_000 });

        // Session check
        const currentUrl = page.url();
        if (currentUrl.includes("/accounts/login") || currentUrl.includes("/challenge/")) {
          console.warn(`[ProfileEnricher] Session blocked at @${username}. Stopping enrichment.`);
          onBlocked?.();
          break;
        }

        // Wait for page to settle
        await page.waitForSelector('main', { timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(1_500 + Math.random() * 1_000);

        const profile = await extractProfileData(page, username);
        results.push(profile);

        console.log(
          `[ProfileEnricher] ✅ @${username} — ` +
          `followers: ${profile.followersCount ?? "?"}, ` +
          `email: ${profile.email ?? "none"}, ` +
          `phone: ${profile.phone ?? "none"}, ` +
          `website: ${profile.website ?? "none"}`
        );

        onProgress?.(i + 1, targets.length, profile);

      } catch (err: any) {
        console.warn(`[ProfileEnricher] ⚠️ Failed @${username}: ${err.message}`);
        // Push minimal stub so we don't lose the username entirely
        results.push({
          username,
          name: username,
          bio: "",
          email: null,
          phone: null,
          website: null,
          category: null,
          followersCount: null,
          followingCount: null,
          postsCount: null,
          isVerified: false,
          isBusiness: false,
          profileUrl: `https://www.instagram.com/${username}/`,
          source: "instagram",
        });
      }

      // Rate limiting: random delay between profiles
      const delay = 3_000 + Math.random() * 4_000;
      // Every 10 profiles: longer cool-down
      const cooldown = (i + 1) % 10 === 0 ? 15_000 + Math.random() * 15_000 : 0;
      await page.waitForTimeout(delay + cooldown);

      if (cooldown > 0) {
        console.log(`[ProfileEnricher] Cool-down after ${i + 1} profiles (${Math.round((delay + cooldown) / 1000)}s)`);
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  return results;
}
