/**
 * plugins/youtube/providers/about-page-scraper.ts
 *
 * Moved from youtube/index.ts's scrapeViaFetch()/scrapeViaBrowser() with no
 * logic changes. This is the per-channel enrichment step (pull website/
 * socials/email off a channel's About page) — a two-level fallback
 * (plain fetch first, Playwright browser on parse failure), same shape as
 * website's hybrid crawler, kept as one provider for the same reason: the
 * fallback decision (did ytInitialData parse?) lives naturally inside a
 * single function and splitting it needs test coverage this pass doesn't
 * have.
 *
 * The YouTube Data API calls (search.list, channels.list) that discover
 * channel IDs and pull stats stay in youtube/index.ts — that's the
 * official API, not a scraped/substitutable source, so it isn't a
 * "provider" in the vendor-swap sense this refactor targets.
 */
import { fetchPage, getBrowserPool, extractEmailsFromText, htmlToText } from "@compx/scraper-core";
import type { SourceProvider, ProviderRunContext } from "@compx/scraper-core";

function extractYtInitialData(html: string): any | null {
  const m = html.match(/var ytInitialData\s*=\s*(\{.*?\});<\/script>/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

async function scrapeViaFetch(channelId: string): Promise<Record<string, any> | null> {
  const aboutUrl = `https://www.youtube.com/channel/${channelId}/about`;
  const page = await fetchPage(aboutUrl);
  if (!page.ok) return null;

  const initialData = extractYtInitialData(page.html);
  if (!initialData) return null;

  const metadata = initialData?.metadata?.channelMetadataRenderer;
  if (!metadata) return null;

  const parsed: Record<string, any> = {
    website: metadata.ownerUrls?.find((u: string) => !u.includes("youtube.com")) || null,
    instagram: metadata.ownerUrls?.find((u: string) => u.includes("instagram.com")) || null,
    facebook: metadata.ownerUrls?.find((u: string) => u.includes("facebook.com")) || null,
    twitter: metadata.ownerUrls?.find((u: string) => u.includes("twitter.com") || u.includes("x.com")) || null,
    tiktok: metadata.ownerUrls?.find((u: string) => u.includes("tiktok.com")) || null,
  };

  const text = htmlToText(page.html);
  const emails = extractEmailsFromText(text);
  if (emails[0]) parsed.email = emails[0];

  return parsed;
}

async function scrapeViaBrowser(channelId: string, proxyServer?: string | null): Promise<Record<string, any> | null> {
  const pool = getBrowserPool();
  const lease = await pool.acquireContext(proxyServer ? { proxy: { server: proxyServer } } : {});

  try {
    const page = await lease.context.newPage();
    await page.goto(`https://www.youtube.com/channel/${channelId}/about`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForTimeout(1500);

    const bodyText = htmlToText(await page.content());
    const emails = extractEmailsFromText(bodyText);

    return {
      email: emails[0] || null,
    };
  } finally {
    await lease.release();
  }
}

export interface YoutubeAboutPageInput {
  channelId: string;
  channelUrl: string;
  proxyServer?: string | null;
}

async function fetchAboutPage(input: YoutubeAboutPageInput, ctx: ProviderRunContext): Promise<Record<string, any>[]> {
  const { channelId, proxyServer } = input;
  const { logger } = ctx;

  let aboutData = await scrapeViaFetch(channelId);
  if (aboutData) {
    await logger.log(`  about-page: fetch succeeded for ${channelId}`);
    return [aboutData];
  }

  await logger.log(`  about-page: fetch parse failed for ${channelId} — falling back to browser`);
  aboutData = await scrapeViaBrowser(channelId, proxyServer);
  if (aboutData) {
    await logger.log(`  about-page: browser fallback succeeded for ${channelId}`);
    return [aboutData];
  }

  return [];
}

export const youtubeAboutPageProvider: SourceProvider<YoutubeAboutPageInput, Record<string, any>> = {
  name: "youtube-about-page-scraper",
  fetch: fetchAboutPage,
};
