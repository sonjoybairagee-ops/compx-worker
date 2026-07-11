/**
 * plugins/website/providers/hybrid-crawler.ts
 *
 * Moved from website/index.ts's scrapeOne() + its private helpers
 * (detectTechStack, extractSocialLinks, findSubPageLinks, crawlSubPages,
 * scrapeLevel1, scrapePlaywright, isAntiBotChallenge, isJsShell) with NO
 * logic changes — this is a structural move, not a rewrite.
 *
 * Scope note: this single provider still internally contains a 3-level
 * fallback (plain fetch -> Playwright -> Playwright+proxy). That is left
 * as one composite provider rather than split into three, because the
 * levels share mutable scrape state (accumulated html/emails) and
 * escalation conditions (isAntiBotChallenge/isJsShell) that would need
 * real redesign — not a mechanical move — to separate safely. Splitting
 * this further is a reasonable future step, but it needs test coverage
 * this refactor pass doesn't have, so it's called out here rather than
 * done silently.
 *
 * URL discovery (DuckDuckGo keyword -> candidate URLs) intentionally
 * stays in website/index.ts — it's a different concern (finding what to
 * scrape) from this provider (how to scrape one URL), not a vendor swap.
 */
import {
  fetchPage,
  extractMetaDescription,
  extractEmailsFromText,
  htmlToText,
  getProxyManager,
  analyzeJobRisk,
  getBrowserPool,
} from "@compx/scraper-core";
import type { SourceProvider, ProviderRunContext } from "@compx/scraper-core";
import * as cheerio from "cheerio";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function detectTechStack(html: string, headers?: any): string[] {
  const stacks: string[] = [];
  const lowerHtml = html.toLowerCase();

  if (lowerHtml.includes("wp-content") || lowerHtml.includes("wp-includes")) stacks.push("WordPress");
  if (lowerHtml.includes("cdn.shopify.com") || lowerHtml.includes("shopify.com")) stacks.push("Shopify");
  if (lowerHtml.includes("_next/static")) stacks.push("Next.js");
  else if (lowerHtml.includes("data-reactroot") || lowerHtml.includes("react")) stacks.push("React");
  if (lowerHtml.includes("data-v-") || lowerHtml.includes("vue")) stacks.push("Vue");
  if (lowerHtml.includes("laravel")) stacks.push("Laravel");
  if (lowerHtml.includes("squarespace.com")) stacks.push("Squarespace");
  if (lowerHtml.includes("wix.com") || lowerHtml.includes("wix-")) stacks.push("Wix");
  if (lowerHtml.includes("webflow.com") || lowerHtml.includes("w-webflow")) stacks.push("Webflow");
  if (lowerHtml.includes("stripe.com")) stacks.push("Stripe");
  if (lowerHtml.includes("hs-scripts.com") || lowerHtml.includes("hubspot")) stacks.push("Hubspot");

  const server = headers?.server?.toLowerCase() || "";
  if (server.includes("cloudflare") || lowerHtml.includes("cloudflare")) stacks.push("Cloudflare");

  return [...new Set(stacks)];
}

function extractSocialLinks(html: string): Record<string, string> {
  const $ = cheerio.load(html);
  const socials: Record<string, string> = {};
  const domains = ["linkedin.com", "instagram.com", "facebook.com", "youtube.com", "twitter.com", "x.com", "tiktok.com"];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (href) {
      const lower = href.toLowerCase();
      domains.forEach((d) => {
        if (lower.includes(d)) {
          const key = d === "x.com" ? "twitter" : d.split(".")[0];
          if (!socials[key]) {
            socials[key] = href;
          }
        }
      });
    }
  });
  return socials;
}

function findSubPageLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const paths = new Set<string>();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const lowerHref = href.toLowerCase();
    const text = $(el).text().toLowerCase();

    if (
      lowerHref.includes("contact") || text.includes("contact") ||
      lowerHref.includes("about") || text.includes("about") ||
      lowerHref.includes("team") || text.includes("team") ||
      lowerHref.includes("company") || text.includes("company") ||
      lowerHref.includes("privacy")
    ) {
      try {
        const fullUrl = new URL(href, baseUrl).toString();
        if (new URL(fullUrl).hostname === new URL(baseUrl).hostname) {
          paths.add(fullUrl);
        }
      } catch (e) {}
    }
  });

  return Array.from(paths).slice(0, 5);
}

async function crawlSubPages(links: string[], logger: ProviderRunContext["logger"]): Promise<string> {
  let combinedHtml = "";

  for (const link of links) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const res = await fetchPage(link, { signal: controller.signal } as any);
      clearTimeout(timeout);

      if (res.ok && res.html) {
        combinedHtml += " " + res.html;
      }
    } catch (e: any) {
      await logger.log(`  Subpage fetch failed/timeout for ${link}`);
    }
    await sleep(500);
  }

  return combinedHtml;
}

async function scrapeLevel1(url: string) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const page = await fetchPage(url, { signal: controller.signal } as any);
    clearTimeout(timeout);

    return page;
  } catch (e: any) {
    return { ok: false, status: 0, html: "", error: e.message };
  }
}

async function scrapePlaywright(url: string, useProxy: boolean, routing: any) {
  const pool = getBrowserPool();
  let proxyConfig = null;
  let pmProxy = null;

  if (useProxy) {
    pmProxy = await getProxyManager().getBest(routing);
    if (pmProxy?.server) {
      proxyConfig = { server: pmProxy.server, username: (pmProxy as any).username, password: (pmProxy as any).password };
    }
  }

  let lease: any = null;
  try {
    lease = await pool.acquireContext({ proxy: proxyConfig });
    const page = await lease.context.newPage();

    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await sleep(2000);

    const html = await page.content();
    const status = res?.status() || 200;

    return { ok: status < 400, status, html, pmProxy };
  } catch (e: any) {
    return { ok: false, status: 0, html: "", error: e.message, pmProxy };
  } finally {
    if (lease) await lease.release();
  }
}

function isAntiBotChallenge(html: string, status: number, headers: any): boolean {
  if (status === 403 || status === 429 || status === 503) return true;

  const lowerHtml = html.toLowerCase();
  if (lowerHtml.includes("<title>just a moment...</title>")) return true;
  if (lowerHtml.includes("cloudflare") && lowerHtml.includes("challenge")) return true;

  if (headers && headers["cf-mitigated"]) return true;

  return false;
}

function isJsShell(html: string): boolean {
  const text = htmlToText(html).trim();
  return text.length < 150 && (html.includes('<div id="root"></div>') || html.includes("__NEXT_DATA__"));
}

export interface WebsiteHybridCrawlerInput {
  url: string;
}

async function scrapeOne(input: WebsiteHybridCrawlerInput, ctx: ProviderRunContext): Promise<any[]> {
  const { url } = input;
  const { logger } = ctx;
  const routing = analyzeJobRisk({ domain: url, type: "website" });

  let html = "";
  let status = 0;
  let headers = {};
  let emails: string[] = [];

  // ----- LEVEL 1: FETCH -----
  await logger.log(`Level 1: Fetching ${url}`);
  let res: any = await scrapeLevel1(url);
  html = res.html;
  status = res.status;
  headers = res.headers || {};

  let needsPlaywright = false;
  let needsProxy = false;

  if (isAntiBotChallenge(html, status, headers)) {
    needsPlaywright = true;
    needsProxy = true;
    await logger.log(`  Level 1 detected Anti-Bot/Challenge (status ${status}). Scaling to Level 3.`);
  } else if (!res.ok || isJsShell(html)) {
    needsPlaywright = true;
    await logger.log(`  Level 1 failed or returned JS shell. Scaling to Level 2.`);
  }

  if (!needsPlaywright && res.ok) {
    emails = extractEmailsFromText(htmlToText(html));

    const subLinks = findSubPageLinks(html, url);
    if (subLinks.length > 0) {
      await logger.log(`  Level 1 Deep Crawl: Found ${subLinks.length} sub-pages to check...`);
      const subHtml = await crawlSubPages(subLinks, logger);
      html += " " + subHtml;
      const subEmails = extractEmailsFromText(htmlToText(subHtml));
      emails = [...new Set([...emails, ...subEmails])];
    }
  }

  // ----- LEVEL 2: PLAYWRIGHT (No Proxy) -----
  if (needsPlaywright && !needsProxy) {
    await logger.log(`Level 2: Playwright (No Proxy) for ${url}`);
    res = await scrapePlaywright(url, false, routing);
    html = res.html;
    status = res.status;

    if (isAntiBotChallenge(html, status, headers)) {
      needsProxy = true;
      await logger.log(`  Level 2 detected Anti-Bot/Challenge (status ${status}). Scaling to Level 3.`);
    } else if (res.ok) {
      emails = extractEmailsFromText(htmlToText(html));
      if (emails.length === 0) {
        const subLinks = findSubPageLinks(html, url);
        if (subLinks.length > 0) {
          await logger.log(`  Level 2 Deep Crawl (via Fetch): Checking ${subLinks.length} sub-pages...`);
          const subHtml = await crawlSubPages(subLinks, logger);
          html += " " + subHtml;
          emails = extractEmailsFromText(htmlToText(subHtml));
        }
      }
    }
  }

  // ----- LEVEL 3: PLAYWRIGHT (With Proxy) -----
  if (needsProxy) {
    await logger.log(`Level 3: Playwright + Proxy for ${url}`);
    res = await scrapePlaywright(url, true, routing);
    html = res.html;

    if (res.ok) {
      if (res.pmProxy) await getProxyManager().markSuccess(res.pmProxy.id, Date.now());
      emails = extractEmailsFromText(htmlToText(html));
      if (emails.length === 0) {
        const subLinks = findSubPageLinks(html, url);
        if (subLinks.length > 0) {
          await logger.log(`  Level 3 Deep Crawl (via Fetch): Checking ${subLinks.length} sub-pages...`);
          const subHtml = await crawlSubPages(subLinks, logger);
          html += " " + subHtml;
          emails = extractEmailsFromText(htmlToText(subHtml));
        }
      }
    } else {
      if (res.pmProxy) await getProxyManager().markFail(res.pmProxy.id);
      await logger.log(`✗ ${url} → Level 3 failed: ${res.error || `HTTP ${res.status}`}`);
      return [];
    }
  }

  if (!html && !res.ok) {
    await logger.log(`✗ ${url} → Final failure. HTTP ${status}`);
    return [];
  }

  emails = [...new Set(emails)];
  const metaDescription = extractMetaDescription(html);
  const techStack = detectTechStack(html, headers);
  const socials = extractSocialLinks(html);

  await logger.log(`✓ ${url} → ${emails.length} email(s), Stack: ${techStack.join(", ")}`);

  return [
    {
      website: url,
      name: null,
      company: new URL(url).hostname.replace(/^www\./, ""),
      email: emails[0] || null,
      emails,
      metaDescription,
      social_links: socials,
      tech_stack: techStack,
      source: "website",
    },
  ];
}

export const websiteHybridCrawlerProvider: SourceProvider<WebsiteHybridCrawlerInput, any> = {
  name: "website-hybrid-crawler",
  fetch: scrapeOne,
};
