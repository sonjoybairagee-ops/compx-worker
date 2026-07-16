/**
 * plugins/linkedin/providers/profile-scraper.ts
 *
 * Deep-enriches LinkedIn profiles by visiting each URL with a logged-in session.
 * Uses SessionManager for optimistic locking + residential proxy + stealth fingerprint.
 *
 * Extracts from each profile:
 *   - Full name, headline, current company, location
 *   - Email + phone from "Contact info" modal (only visible when logged in)
 *   - Website from contact info
 *   - About/summary text
 *   - Connection count
 *
 * Rate limiting:
 *   - 15-30s between profiles (LinkedIn is very sensitive to fast scraping)
 *   - 60s cool-down every 5 profiles
 *   - Immediate stop if session is restricted/banned
 */
import { getBrowserPool, SessionManager, extractEmailsFromText } from "@compx/scraper-core";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import type { Page } from "playwright";

// ─── Supabase singleton ───────────────────────────────────────────────────────
let _supabase: any = null;
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL || "",
      process.env.SUPABASE_SERVICE_ROLE_KEY || "",
      { realtime: { transport: ws as any } }
    );
  }
  return _supabase;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// FIX: previously this exact regex was duplicated almost verbatim in both
// scrapePersonProfile() and scrapeCompanyPage(), and it was hardcoded to
// Bangladesh numbers specifically (the `880`/`1[3-9]` prefix logic). If a
// lead's LinkedIn profile has an international number that doesn't match
// that shape, it would silently miss it. Pulled into one shared helper
// and loosened to a general international-leaning pattern: optional `+`
// followed by 8-15 digits (allowing common separators), which covers BD
// numbers too without being BD-specific. Not perfect (phone parsing never
// is without a proper library like libphonenumber), but no longer biased
// toward one country and no longer duplicated.
function extractPhoneFromText(text: string): string | null {
  if (!text) return null;
  const m = text.match(/\+?\d[\d\s().-]{7,17}\d/);
  return m?.[0]?.trim() || null;
}

export interface LinkedinEnrichedProfile {
  profileUrl: string;
  type: "person" | "company";
  name: string | null;
  headline: string | null;
  company: string | null;
  location: string | null;
  about: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  connectionCount: string | null;
  followerCount: string | null;
  source: "linkedin";
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

/** Scrape a LinkedIn personal profile (/in/). */
async function scrapePersonProfile(page: Page, profileUrl: string): Promise<LinkedinEnrichedProfile> {
  const cleanUrl = profileUrl.split("?")[0];
  await page.goto(cleanUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // Check for login wall or restriction
  const isLoginWall = await page.locator('text="Join now"').first().isVisible({ timeout: 3000 }).catch(() => false);
  const isRestricted = await page.locator('text="temporarily restricted"').first().isVisible({ timeout: 3000 }).catch(() => false);
  if (isLoginWall || isRestricted) throw new Error("LINKEDIN_SESSION_BLOCKED");

  await page.waitForSelector('main', { timeout: 10_000 }).catch(() => {});
  await sleep(2_000 + Math.random() * 1_500);

  // Name
  const name = await safeText(page, 'h1', 4000) || null;

  // Headline (job title)
  const headline = await safeText(page, '.text-body-medium.break-words', 3000) || null;

  // Location
  const location = await safeText(page, '.text-body-small.inline.t-black--light.break-words', 3000) || null;

  // About
  const about = await safeText(page, '#about ~ .pvs-list, .pv-shared-text-with-see-more', 3000) || null;

  // Connection/follower count
  // FIX: `span.t-bold` alone is far too generic — LinkedIn uses that same
  // utility class on the headline, company name, and other bold text
  // throughout the page, so this was liable to grab the wrong text
  // entirely rather than an actual connection count. Instead, search for
  // an element whose own text specifically mentions "connection"/
  // "follower" (LinkedIn renders this as e.g. "500+ connections").
  const connectionCount = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll("span, a"));
    for (const el of candidates) {
      const txt = el.textContent?.trim() || "";
      if (/^\d[\d,.+]*\s*(connections?|followers?)$/i.test(txt)) {
        return txt;
      }
    }
    return null;
  }).catch(() => null);

  // Current company from experience section
  const company = await page.evaluate(() => {
    const exp = document.querySelector('#experience ~ .pvs-list li');
    if (!exp) return null;
    const titleEl = exp.querySelector('span[aria-hidden="true"]');
    return titleEl?.textContent?.trim() || null;
  }).catch(() => null);

  // Contact info modal — most valuable: email, phone, website
  let email: string | null = null;
  let phone: string | null = null;
  let website: string | null = null;

  try {
    const contactBtn = page.locator(
      'a[href*="/overlay/contact-info/"], a[aria-label*="contact info" i], a[aria-label*="Contact info"]'
    ).first();

    if (await contactBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await contactBtn.click();
      await sleep(2_000);

      const modal = page.locator('.artdeco-modal__content, div[role="dialog"]').first();
      const modalText = await modal.innerText({ timeout: 5_000 }).catch(() => "");

      // Email
      const emailHref = await modal.locator('a[href^="mailto:"]').first().getAttribute("href").catch(() => null);
      email = emailHref ? emailHref.replace("mailto:", "").trim() : null;
      if (!email && modalText) {
        const found = extractEmailsFromText(modalText);
        email = found[0] || null;
      }

      // Phone
      const phoneHref = await modal.locator('a[href^="tel:"]').first().getAttribute("href").catch(() => null);
      phone = phoneHref ? phoneHref.replace("tel:", "").trim() : null;
      if (!phone && modalText) {
        phone = extractPhoneFromText(modalText);
      }

      // Website
      const webEl = await modal.locator('a[href^="http"]:not([href*="linkedin.com"])').first().getAttribute("href").catch(() => null);
      website = webEl?.split("?")[0] || null;

      // Close modal
      await page.locator('.artdeco-modal__dismiss, button[aria-label="Dismiss"]').first().click().catch(() => {});
      await sleep(1_000);
    }
  } catch {}

  // Fallback: body text email scan
  if (!email) {
    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
    email = extractEmailsFromText(bodyText)[0] || null;
  }

  return {
    profileUrl: cleanUrl,
    type: "person",
    name: name?.trim() || null,
    headline: headline?.trim() || null,
    company: company?.trim() || null,
    location: location?.trim() || null,
    about: about?.trim() || null,
    email,
    phone,
    website,
    connectionCount,
    followerCount: null,
    source: "linkedin",
  };
}

/** Scrape a LinkedIn company page (/company/). */
async function scrapeCompanyPage(page: Page, profileUrl: string): Promise<LinkedinEnrichedProfile> {
  const cleanUrl = profileUrl.split("?")[0];
  const aboutUrl = cleanUrl.replace(/\/$/, "") + "/about/";

  await page.goto(aboutUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForSelector('main', { timeout: 10_000 }).catch(() => {});
  await sleep(2_000 + Math.random() * 1_500);

  const isLoginWall = await page.locator('text="Join now"').first().isVisible({ timeout: 2000 }).catch(() => false);
  if (isLoginWall) throw new Error("LINKEDIN_SESSION_BLOCKED");

  const name = await safeText(page, 'h1', 4000) || null;
  const headline = await safeText(page, '.org-top-card-summary__tagline', 3000) || null;
  const about = await safeText(page, '.org-about-us-organization-description__text, .org-about-company-module__description', 3000) || null;
  const location = await safeText(page, '.org-location-module__location-name', 3000) || null;

  const followerText = await safeText(page, '.org-top-card-summary__follower-count', 3000);
  const followerCount = followerText || null;

  // Website from about section
  const website = await page.locator('a[data-tracking-control-name="about_website"]').first().getAttribute("href").catch(() => null);

  // Body text email/phone scan
  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
  const email = extractEmailsFromText(bodyText).filter(e => !e.includes("linkedin.com"))[0] || null;
  const phone = extractPhoneFromText(bodyText);

  return {
    profileUrl: cleanUrl,
    type: "company",
    name: name?.trim() || null,
    headline: headline?.trim() || null,
    company: name?.trim() || null,
    location: location?.trim() || null,
    about: about?.trim() || null,
    email,
    phone,
    website: website?.split("?")[0] || null,
    connectionCount: null,
    followerCount,
    source: "linkedin",
  };
}

export interface ProfileEnricherOptions {
  proxy?: any;
  maxProfiles?: number;
  onProgress?: (done: number, total: number, profile: LinkedinEnrichedProfile) => void;
  onBlocked?: () => void;
}

export interface ProfileEnricherInput {
  stubs: Array<{ profileUrl: string; type: "person" | "company"; name: string }>;
  options?: ProfileEnricherOptions;
}

/**
 * Main entry: acquires a LinkedIn session + residential proxy, then
 * visits each profile URL and returns fully enriched data.
 */
export async function enrichLinkedinProfiles(input: ProfileEnricherInput): Promise<LinkedinEnrichedProfile[]> {
  const { stubs, options = {} } = input;
  const { proxy, maxProfiles = 50, onProgress, onBlocked } = options;

  const targets = stubs.slice(0, maxProfiles);
  if (targets.length === 0) return [];

  const supabase = getSupabase();
  const sessionManager = new SessionManager(supabase);
  const pool = getBrowserPool();
  const poolLease = await pool.acquireContext({});
  const browser = (poolLease as any).context.browser();

  const sessionResult = await sessionManager.acquireContextWithSession("linkedin", browser, {
    proxy,
    platform: "linkedin",
  });

  if (!sessionResult) {
    await poolLease.release();
    throw new Error("LINKEDIN_SESSION_REQUIRED: No active LinkedIn session. Run login.ts first.");
  }

  const { context, lease: sessionLease } = sessionResult;
  const page = await context.newPage();
  const results: LinkedinEnrichedProfile[] = [];
  let sessionBlocked = false;

  try {
    for (let i = 0; i < targets.length; i++) {
      const { profileUrl, type, name } = targets[i];

      try {
        console.log(`[LinkedIn] Visiting ${type} profile ${i + 1}/${targets.length}: ${name || profileUrl}`);

        const profile = type === "company"
          ? await scrapeCompanyPage(page, profileUrl)
          : await scrapePersonProfile(page, profileUrl);

        results.push(profile);

        console.log(
          `[LinkedIn] ✅ ${profile.name || name} — ` +
          `${profile.email ? "✉️ " + profile.email : "no email"} | ` +
          `${profile.phone ? "📞 " + profile.phone : "no phone"} | ` +
          `${profile.company ? "🏢 " + profile.company : ""}`
        );

        onProgress?.(i + 1, targets.length, profile);

      } catch (err: any) {
        if (err.message?.includes("LINKEDIN_SESSION_BLOCKED")) {
          console.warn("[LinkedIn] 🚨 Session blocked! Stopping enrichment.");
          sessionBlocked = true;
          onBlocked?.();
          break;
        }
        console.warn(`[LinkedIn] ⚠️ Failed ${profileUrl}: ${err.message}`);
        // Push minimal stub
        results.push({
          profileUrl,
          type,
          name: name || null,
          headline: null,
          company: null,
          location: null,
          about: null,
          email: null,
          phone: null,
          website: null,
          connectionCount: null,
          followerCount: null,
          source: "linkedin",
        });
      }

      // LinkedIn-specific rate limiting — much stricter than Instagram
      const delay = 15_000 + Math.random() * 15_000; // 15-30s
      const cooldown = (i + 1) % 5 === 0 ? 60_000 + Math.random() * 30_000 : 0; // 60-90s every 5
      if (cooldown > 0) {
        console.log(`[LinkedIn] Cool-down after ${i + 1} profiles (${Math.round((delay + cooldown) / 1000)}s)`);
      }
      await page.waitForTimeout(delay + cooldown);
    }
  } finally {
    const finalState = await context.storageState().catch(() => null);
    await page.close().catch(() => {});
    await sessionLease.release(
      sessionBlocked
        ? { invalidate: true }
        : { updatedState: finalState ?? undefined }
    );
    await context.close().catch(() => {});
    await poolLease.release().catch(() => {});
  }

  return results;
}