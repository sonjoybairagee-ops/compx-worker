/**
 * plugins/website/index.ts
 *
 * 3-Level Fallback Architecture with Deep Crawling and Tech Stack Detection
 */

import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import {
  fetchPage,
  extractMetaDescription,
  extractEmailsFromText,
  htmlToText,
  validateLead,
  saveLeads,
  baseRowMapper,
  getProxyManager,
  analyzeJobRisk,
  createLogger,
  checkSourceAccess,
  chargeBatchForLeads,
  calculateLeadCost,
  getCachedScrape,
  setCachedScrape,
  getBrowserPool,
} from "@compx/scraper-core";
import type { PluginContext, PluginResult, SourcePlugin } from "@compx/scraper-core";
import * as cheerio from "cheerio";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
  {
    realtime: {
      transport: ws as any,
    },
  }
);

interface WebsiteJobInput {
  urls?: string[];
  keyword?: string;
  location?: string;
  maxResults?: number;
}

const EXCLUDED_RESULT_DOMAINS = [
  "facebook.com", "instagram.com", "twitter.com", "x.com", "linkedin.com",
  "youtube.com", "tiktok.com", "pinterest.com", "yelp.com", "tripadvisor.com",
  "wikipedia.org", "google.com", "maps.google.com", "amazon.com",
  "indeed.com", "glassdoor.com", "bbb.org", "yellowpages.com",
  "duckduckgo.com",
];

function isUsefulResultUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return !EXCLUDED_RESULT_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

async function discoverUrlsViaSearch(
  keyword: string,
  location: string | undefined,
  maxResults: number,
  logger: ReturnType<typeof createLogger>
): Promise<string[]> {
  const query = location ? `${keyword} ${location}` : keyword;
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  let page;
  try {
    page = await fetchPage(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    } as any);
  } catch (err: any) {
    await logger.log(`Keyword search fetch failed: ${err.message} — falling back to 0 candidate URLs`);
    return [];
  }

  if (!page.ok) {
    await logger.log(`Keyword search returned HTTP ${page.status} — falling back to 0 candidate URLs`);
    return [];
  }

  const linkRe = /<a\b[^>]*\bhref="([^"]+)"[^>]*>/g;
  const found: string[] = [];
  let m: RegExpExecArray | null;

  while ((m = linkRe.exec(page.html))) {
    let href = m[1].replace(/&amp;/g, "&");

    if (href.startsWith("/l/?") || href.includes("/l/?uddg=")) {
      const uddgMatch = href.match(/[?&]uddg=([^&]+)/);
      if (uddgMatch) href = decodeURIComponent(uddgMatch[1]);
      else continue;
    }

    if (!/^https?:\/\//i.test(href)) continue;
    if (href.includes("duckduckgo.com")) continue;
    found.push(href);
  }

  const deduped = [...new Set(found)].filter(isUsefulResultUrl);
  return deduped.slice(0, maxResults);
}

// ---- Tech Stack & Social Links ----
function detectTechStack(html: string, headers?: any): string[] {
  const stacks: string[] = [];
  const lowerHtml = html.toLowerCase();
  
  if (lowerHtml.includes('wp-content') || lowerHtml.includes('wp-includes')) stacks.push('WordPress');
  if (lowerHtml.includes('cdn.shopify.com') || lowerHtml.includes('shopify.com')) stacks.push('Shopify');
  if (lowerHtml.includes('_next/static')) stacks.push('Next.js');
  else if (lowerHtml.includes('data-reactroot') || lowerHtml.includes('react')) stacks.push('React');
  if (lowerHtml.includes('data-v-') || lowerHtml.includes('vue')) stacks.push('Vue');
  if (lowerHtml.includes('laravel')) stacks.push('Laravel');
  if (lowerHtml.includes('squarespace.com')) stacks.push('Squarespace');
  if (lowerHtml.includes('wix.com') || lowerHtml.includes('wix-')) stacks.push('Wix');
  if (lowerHtml.includes('webflow.com') || lowerHtml.includes('w-webflow')) stacks.push('Webflow');
  if (lowerHtml.includes('stripe.com')) stacks.push('Stripe');
  if (lowerHtml.includes('hs-scripts.com') || lowerHtml.includes('hubspot')) stacks.push('Hubspot');
  
  const server = headers?.server?.toLowerCase() || '';
  if (server.includes('cloudflare') || lowerHtml.includes('cloudflare')) stacks.push('Cloudflare');
  
  return [...new Set(stacks)];
}

function extractSocialLinks(html: string): Record<string, string> {
  const $ = cheerio.load(html);
  const socials: Record<string, string> = {};
  const domains = ['linkedin.com', 'instagram.com', 'facebook.com', 'youtube.com', 'twitter.com', 'x.com', 'tiktok.com'];
  
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) {
      const lower = href.toLowerCase();
      domains.forEach(d => {
        if (lower.includes(d)) {
          const key = d === 'x.com' ? 'twitter' : d.split('.')[0];
          // Keep the first URL found for each platform
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
  
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const lowerHref = href.toLowerCase();
    const text = $(el).text().toLowerCase();
    
    // Check if it's a target sub-page
    if (
      lowerHref.includes('contact') || text.includes('contact') ||
      lowerHref.includes('about') || text.includes('about') ||
      lowerHref.includes('team') || text.includes('team') ||
      lowerHref.includes('company') || text.includes('company') ||
      lowerHref.includes('privacy')
    ) {
      try {
        const fullUrl = new URL(href, baseUrl).toString();
        // Only same-domain links
        if (new URL(fullUrl).hostname === new URL(baseUrl).hostname) {
          paths.add(fullUrl);
        }
      } catch (e) {}
    }
  });
  
  return Array.from(paths).slice(0, 5); // Max 5 subpages to keep it fast
}

// ---- Sub-page crawler with timeout & rate limit ----
async function crawlSubPages(links: string[], logger: ReturnType<typeof createLogger>): Promise<string> {
  let combinedHtml = "";
  
  for (const link of links) {
    try {
      // 8s hard timeout via AbortController in fetchPage (if supported) or manual timeout
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
    await sleep(500); // rate limiting
  }
  
  return combinedHtml;
}

// ---- Level 1: Fetch ----
async function scrapeLevel1(url: string, logger: ReturnType<typeof createLogger>) {
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

// ---- Level 2/3: Playwright ----
async function scrapePlaywright(url: string, useProxy: boolean, routing: any, logger: ReturnType<typeof createLogger>) {
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
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await sleep(2000); // Let JS execute
    
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
  if (lowerHtml.includes('<title>just a moment...</title>')) return true;
  if (lowerHtml.includes('cloudflare') && lowerHtml.includes('challenge')) return true;
  
  // cf-mitigated header
  if (headers && headers['cf-mitigated']) return true;
  
  return false;
}

function isJsShell(html: string): boolean {
  const text = htmlToText(html).trim();
  // If the extracted text is incredibly short, it's likely a JS shell that didn't render
  return text.length < 150 && (html.includes('<div id="root"></div>') || html.includes('__NEXT_DATA__'));
}

async function scrapeOne(url: string, jobId: string, logger: ReturnType<typeof createLogger>) {
  const routing = analyzeJobRisk({ domain: url, type: "website" });
  
  let html = "";
  let status = 0;
  let headers = {};
  let emails: string[] = [];
  
  // ----- LEVEL 1: FETCH -----
  await logger.log(`Level 1: Fetching ${url}`);
  let res: any = await scrapeLevel1(url, logger);
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

  // Check if we already found emails in Level 1
  if (!needsPlaywright && res.ok) {
    emails = extractEmailsFromText(htmlToText(html));
    
    // Deep crawl for emails via Fetch (Fast)
    const subLinks = findSubPageLinks(html, url);
    if (subLinks.length > 0) {
      await logger.log(`  Level 1 Deep Crawl: Found ${subLinks.length} sub-pages to check...`);
      const subHtml = await crawlSubPages(subLinks, logger);
      html += " " + subHtml; // Aggregate for tech stack / socials
      const subEmails = extractEmailsFromText(htmlToText(subHtml));
      emails = [...new Set([...emails, ...subEmails])];
    }
  }

  // ----- LEVEL 2: PLAYWRIGHT (No Proxy) -----
  if (needsPlaywright && !needsProxy) {
    await logger.log(`Level 2: Playwright (No Proxy) for ${url}`);
    res = await scrapePlaywright(url, false, routing, logger);
    html = res.html;
    status = res.status;
    
    if (isAntiBotChallenge(html, status, headers)) {
      needsProxy = true;
      await logger.log(`  Level 2 detected Anti-Bot/Challenge (status ${status}). Scaling to Level 3.`);
    } else if (res.ok) {
      emails = extractEmailsFromText(htmlToText(html));
      // Try subpages if still no emails
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
    res = await scrapePlaywright(url, true, routing, logger);
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
      return null;
    }
  }
  
  if (!html && !res.ok) {
    await logger.log(`✗ ${url} → Final failure. HTTP ${status}`);
    return null;
  }

  // Extraction
  emails = [...new Set(emails)];
  const metaDescription = extractMetaDescription(html);
  const techStack = detectTechStack(html, headers);
  const socials = extractSocialLinks(html);

  await logger.log(`✓ ${url} → ${emails.length} email(s), Stack: ${techStack.join(', ')}`);

  return {
    website: url,
    name: null,
    company: new URL(url).hostname.replace(/^www\./, ""),
    email: emails[0] || null,
    emails,
    metaDescription,
    social_links: socials,
    tech_stack: techStack,
    source: "website",
  };
}

async function run(ctx: PluginContext): Promise<PluginResult> {
  const input = ctx.input as WebsiteJobInput;
  const logger = createLogger(ctx.jobId);

  // ── Plan gate ──────────────────────────────────────────────────────────
  const access = await checkSourceAccess(supabase, "website", ctx.userId, ctx.orgId);
  if (!access.allowed) {
    await logger.log(`Blocked: website not available on ${access.planName} plan.`);
    await logger.close();
    return {
      leads_found: 0, saved: 0, errors: 0, blocked: true,
      message: `Website scraping isn't available on your current plan.` +
        (access.requiredTier ? ` Upgrade to ${access.requiredTier}.` : ""),
    };
  }

  let urls: string[] = input.urls || [];
  if (urls.length === 0 && input.keyword) {
    await logger.log(`No urls provided — searching by keyword "${input.keyword}"`);
    urls = await discoverUrlsViaSearch(input.keyword, input.location, input.maxResults ?? 10, logger);
  }

  if (urls.length === 0) {
    await logger.log(`No URLs to scrape.`);
    await logger.close();
    return { leads_found: 0, saved: 0, errors: 0, emails: [] };
  }

  // ── Cache Check (Idempotent) ──────────────────────────────────────────────
  const activeEnrichments = Object.keys((input as any).enrichments || {}).filter(k => (input as any).enrichments[k]);
  const cacheKeyTarget = input.keyword ? `search:${input.keyword}` : `urls:${urls.join(",")}`;
  const cacheHit = await getCachedScrape(supabase, "website", cacheKeyTarget, "v1", logger);

  const scraped: any[] = [];
  let skippedNoBalance = 0;

  if (cacheHit.hit && cacheHit.data) {
    for (const item of cacheHit.data) scraped.push(item);
  } else {
    for (let i = 0; i < urls.length; i++) {
      const result = await scrapeOne(urls[i], ctx.jobId, logger);
      if (result) {
        const validation = validateLead(result);
        if (validation.valid) scraped.push(result);
        else await logger.log(`  rejected: ${validation.reasons.join(", ")}`);
      }

      await ctx.updateProgress({ processedCount: i + 1, totalCount: urls.length });
    }
    
    if (scraped.length > 0) {
      await setCachedScrape(supabase, "website", cacheKeyTarget, scraped, "v1");
    }
  }

  await logger.close();

  const uploadResult = await saveLeads(supabase, scraped, ctx.userId, ctx.orgId, (item, userId, orgId) => {
    const row = baseRowMapper(item, userId, orgId, "website");
    row.social_links = item.social_links || {};
    row.tech_stack = item.tech_stack || [];
    return row;
  });

  // ── Deferred Charging ─────────────────────────────────────────────────────
  if (uploadResult.saved > 0) {
    const costPerLead = calculateLeadCost("website", {
      isCacheHit: cacheHit.hit,
      enrichments: activeEnrichments,
    });
    const totalCost = costPerLead * uploadResult.saved;
    const chargeResult = await chargeBatchForLeads(supabase, ctx.userId, ctx.orgId, totalCost);
    if (!chargeResult.charged) {
      console.error(`Failed to charge ${totalCost} credits: ${chargeResult.reason}`);
    }
  }

  return {
    leads_found: scraped.length,
    saved: uploadResult.saved,
    errors: uploadResult.errors,
    skippedNoBalance,
    emails: scraped.flatMap((s) => s.emails || []),
  };
}

export const websitePlugin: SourcePlugin = {
  name: "website",
  requiresBrowser: true, // Need browser available for Level 2 & 3
  run,
};
