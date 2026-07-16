/**
 * plugins/youtube/providers/about-page-scraper.ts
 *
 * About page scraper — only called when YouTube Data API doesn't return an email.
 * (Most channels that publicly share their email have it in brandingSettings.channel.businessEmail)
 *
 * Strategy:
 * 1. Fast fetch → parse ytInitialData JSON (website, social links)
 * 2. If email still missing → Browser → click "View email address" button
 *
 * The "View email address" button on YouTube obfuscates the email with JS.
 * Clicking it renders the actual email in the DOM.
 */
import { fetchPage, getBrowserPool, extractEmailsFromText, htmlToText } from "@compx/scraper-core";
import type { SourceProvider, ProviderRunContext } from "@compx/scraper-core";

const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const IGNORE_EMAIL_DOMAINS = ["youtube.com", "google.com", "youtu.be", "example.com"];

function cleanEmail(email: string): string | null {
  const lower = email.toLowerCase();
  if (IGNORE_EMAIL_DOMAINS.some(d => lower.includes(d))) return null;
  return email;
}

function extractYtInitialData(html: string): any | null {
  // Try multiple patterns — YouTube changes the output format occasionally
  const patterns = [
    /ytInitialData\s*=\s*(\{.+?\})\s*;\s*<\/script>/s,
    /window\["ytInitialData"\]\s*=\s*(\{.+?\})\s*;/s,
    /ytInitialData\s*=\s*(\{.+?\})\s*;/s,
  ];
  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m) {
      try { return JSON.parse(m[1]); } catch {}
    }
  }
  return null;
}

/** Recursively search for a key in nested JSON */
function deepFind(obj: any, key: string, maxDepth = 8): any {
  if (!obj || typeof obj !== "object" || maxDepth === 0) return null;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const found = deepFind(v, key, maxDepth - 1);
    if (found !== null) return found;
  }
  return null;
}

/** Extract all social links and emails from ytInitialData */
function parseYtInitialData(data: any): Record<string, string | null> {
  const result: Record<string, string | null> = {
    website: null,
    instagram: null,
    facebook: null,
    twitter: null,
    tiktok: null,
    email: null,
  };

  if (!data) return result;

  // Channel links are in channelMetadataRenderer.ownerUrls or
  // aboutChannelRenderer.links[].channelExternalLinkViewModel
  const ownerUrls: string[] = deepFind(data, "ownerUrls") || [];
  for (const url of ownerUrls) {
    if (url.includes("instagram.com")) result.instagram = url;
    else if (url.includes("facebook.com")) result.facebook = url;
    else if (url.includes("twitter.com") || url.includes("x.com")) result.twitter = url;
    else if (url.includes("tiktok.com")) result.tiktok = url;
    else if (!url.includes("youtube.com")) result.website = url;
  }

  // Newer YouTube layout: aboutChannelRenderer → links[]
  const links: any[] = deepFind(data, "links") || [];
  for (const link of links) {
    const href =
      link?.channelExternalLinkViewModel?.link?.content ||
      link?.navigationEndpoint?.urlEndpoint?.url ||
      "";
    if (!href) continue;

    // YouTube wraps external URLs in redirect: extract actual URL
    let actualUrl = href;
    if (href.includes("redirect?q=")) {
      const m = href.match(/redirect\?q=([^&]+)/);
      if (m) actualUrl = decodeURIComponent(m[1]);
    }

    if (actualUrl.includes("instagram.com") && !result.instagram) result.instagram = actualUrl;
    else if (actualUrl.includes("facebook.com") && !result.facebook) result.facebook = actualUrl;
    else if ((actualUrl.includes("twitter.com") || actualUrl.includes("x.com")) && !result.twitter) result.twitter = actualUrl;
    else if (actualUrl.includes("tiktok.com") && !result.tiktok) result.tiktok = actualUrl;
    else if (!actualUrl.includes("youtube.com") && !result.website) result.website = actualUrl;
  }

  return result;
}

async function scrapeViaFetch(channelId: string, channelUrl: string): Promise<Record<string, any> | null> {
  const isHandle = channelId.startsWith("@");
  const aboutUrl = isHandle
    ? `${channelUrl.replace(/\/$/, "")}/about`
    : `https://www.youtube.com/channel/${channelId}/about`;

  const page = await fetchPage(aboutUrl);
  if (!page?.ok) return null;

  const initialData = extractYtInitialData(page.html);
  const parsed = parseYtInitialData(initialData);

  // Email scan on full page text (catches mailto: links)
  const text = htmlToText(page.html);
  const rawEmails = text.match(EMAIL_REGEX) || [];
  const emails = rawEmails.map(cleanEmail).filter(Boolean) as string[];
  if (emails.length > 0 && !parsed.email) parsed.email = emails[0];

  // Return if we found anything useful
  if (parsed.email || parsed.website || parsed.instagram || parsed.facebook) {
    return parsed;
  }

  return null;
}

async function scrapeViaBrowser(
  channelId: string,
  channelUrl: string,
  proxyServer?: string | null
): Promise<Record<string, any> | null> {
  const pool = getBrowserPool();
  const lease = await pool.acquireContext(
    proxyServer ? { proxy: { server: proxyServer } } : {}
  );

  try {
    const page = await lease.context.newPage();

    const isHandle = channelId.startsWith("@");
    const aboutUrl = isHandle
      ? `${channelUrl.replace(/\/$/, "")}/about`
      : `https://www.youtube.com/channel/${channelId}/about`;

    await page.goto(aboutUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(2_000);

    // ── Click "View email address" button ────────────────────────────────────
    // YouTube hides business emails behind this button (JS obfuscation)
    const emailButtonSelectors = [
      'yt-formatted-string:has-text("View email address")',
      'yt-formatted-string:has-text("ইমেল ঠিকানা দেখুন")',  // Bengali
      'button:has-text("View email")',
      '#email-reveal-button',
      '[data-purpose="email-reveal"]',
    ];

    for (const sel of emailButtonSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 3000 })) {
          await btn.click();

          // FIX: a blind fixed sleep here is wrong in both directions —
          // YouTube usually reveals the email in 1-3s, so waiting a flat
          // 60s every time wastes ~57s on the common case and risks the
          // BullMQ job being marked "stalled" (lockDuration: 60_000) if
          // several channels in a batch need the browser fallback back to
          // back. But a short fixed wait (the old 1.5s) sometimes wasn't
          // enough either. So instead of guessing a duration, poll the
          // actual DOM for the email to show up (condition-based wait),
          // capped at 60s as a safety ceiling for the rare slow case —
          // this returns in ~1-3s normally and only burns the full 60s
          // budget when something is genuinely stuck.
          try {
            await page.waitForFunction(
              (regexSrc: string) => {
                const re = new RegExp(regexSrc);
                return re.test(document.body.innerText || "");
              },
              EMAIL_REGEX.source,
              { timeout: 60_000, polling: 500 }
            );
          } catch {
            // Timed out waiting for an email to appear — proceed anyway,
            // the extraction below will just come back empty and the
            // caller already treats a missing email as a normal outcome.
          }
          break;
        }
      } catch {}
    }

    // Now extract emails from the rendered page
    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
    const rawEmails = bodyText.match(EMAIL_REGEX) || [];
    const emails = rawEmails.map(cleanEmail).filter(Boolean) as string[];

    // Also try to get social links from rendered DOM
    const links: string[] = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href*="http"]'))
        .map(a => (a as HTMLAnchorElement).href)
        .filter(h => !h.includes("youtube.com"));
    }).catch(() => []);

    const result: Record<string, any> = {
      email: emails[0] || null,
    };

    for (const link of links) {
      if (link.includes("instagram.com") && !result.instagram) result.instagram = link;
      if (link.includes("facebook.com") && !result.facebook) result.facebook = link;
      if ((link.includes("twitter.com") || link.includes("x.com")) && !result.twitter) result.twitter = link;
      if (link.includes("tiktok.com") && !result.tiktok) result.tiktok = link;
    }

    return result;
  } finally {
    await lease.release();
  }
}

export interface YoutubeAboutPageInput {
  channelId: string;
  channelUrl: string;
  proxyServer?: string | null;
  alreadyHasEmail?: boolean; // skip if API already gave us email
}

async function fetchAboutPage(input: YoutubeAboutPageInput, ctx: ProviderRunContext): Promise<Record<string, any>[]> {
  const { channelId, channelUrl, proxyServer, alreadyHasEmail } = input;
  const { logger } = ctx;

  // If API already gave email, we still run fetch to get website/social links
  // but skip browser fallback
  let aboutData = await scrapeViaFetch(channelId, channelUrl);

  if (aboutData?.email || (alreadyHasEmail && aboutData)) {
    await logger.log(`  ✓ about-page (fetch): ${channelId} — email: ${aboutData.email ? "✅" : "skipped (API)"}, website: ${aboutData.website ? "✅" : "none"}`);
    return [aboutData || {}];
  }

  if (!alreadyHasEmail) {
    // Browser fallback — only when API AND fetch both missed the email
    await logger.log(`  ⚠ about-page (fetch miss): ${channelId} — browser fallback for "View email" button`);
    const browserData = await scrapeViaBrowser(channelId, channelUrl, proxyServer);

    if (browserData) {
      const merged = { ...(aboutData || {}), ...browserData };
      await logger.log(`  ✓ about-page (browser): ${channelId} — email: ${merged.email ? "✅ " + merged.email : "none"}`);
      return [merged];
    }
  }

  await logger.log(`  ✗ about-page: all methods failed for ${channelId}`);
  return aboutData ? [aboutData] : [];
}

export const youtubeAboutPageProvider: SourceProvider<YoutubeAboutPageInput, Record<string, any>> = {
  name: "youtube-about-page-scraper",
  fetch: fetchAboutPage,
};