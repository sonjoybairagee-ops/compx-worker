/**
 * CompX Worker — src/jobs/deepScrapeJob.js
 * Deep scrape using Puppeteer with anti-bot techniques + proxy support
 *
 * PhantomBuster method:
 * 1. Stealth mode (no webdriver fingerprint)
 * 2. Human-like delays + mouse movement
 * 3. Random viewport + user agent
 * 4. Proxy injection
 * 5. Pagination handling
 */

import puppeteer from "puppeteer";
import { supabase } from "../config/supabase.js";

// ── Anti-bot: random human delay ─────────────────────────────────────────────
const humanDelay = (min = 800, max = 2500) =>
  new Promise(r => setTimeout(r, min + Math.random() * (max - min)));

// ── Stealth config ────────────────────────────────────────────────────────────
const STEALTH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-blink-features=AutomationControlled",
  "--disable-web-security",
  "--disable-features=IsolateOrigins,site-per-process",
  "--window-size=1366,768",
];

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ── Build launch args with optional proxy ─────────────────────────────────────
function buildLaunchArgs(proxyUrl) {
  const args = [...STEALTH_ARGS];
  if (proxyUrl) {
    args.push(`--proxy-server=${proxyUrl}`);
    console.log(`[DeepScrape] Using proxy: ${proxyUrl}`);
  }
  return args;
}

// ── Stealth page setup ────────────────────────────────────────────────────────
async function setupStealthPage(browser) {
  const page = await browser.newPage();

  // Remove webdriver fingerprint
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "plugins",   { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    window.chrome = { runtime: {} };
  });

  await page.setUserAgent(randomUA());
  await page.setViewport({
    width:  1366 + Math.floor(Math.random() * 100),
    height: 768  + Math.floor(Math.random() * 50),
  });

  // Block ads + tracking — faster load
  await page.setRequestInterception(true);
  page.on("request", req => {
    const url  = req.url();
    const type = req.resourceType();
    if (type === "image" || type === "font" || type === "media") { req.abort(); return; }
    if (
      url.includes("doubleclick") ||
      url.includes("googlesyndication") ||
      url.includes("analytics")
    ) { req.abort(); return; }
    req.continue();
  });

  return page;
}

// ── Platform-specific deep scrapers ──────────────────────────────────────────

async function deepScrapeGoogleMaps(page, inputData) {
  const { url, category, location } = inputData;
  const searchUrl = url || `https://www.google.com/maps/search/${encodeURIComponent(`${category || "business"} ${location || ""}`)}`;

  await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 30000 });
  await humanDelay(2000, 4000);

  const results = [];

  // Scroll to load more results
  const feed = await page.$('div[role="feed"]');
  if (feed) {
    for (let i = 0; i < 5; i++) {
      await page.evaluate(el => el.scrollBy(0, 500), feed);
      await humanDelay(1200, 2000);
    }
  }

  // Extract business cards
  const cards = await page.$$('a[href*="/maps/place/"]');
  console.log(`[DeepScrape Maps] Found ${cards.length} cards`);

  for (const card of cards.slice(0, 20)) {
    try {
      await card.click();
      await humanDelay(1500, 2500);

      const data = await page.evaluate(() => {
        const getText = sel => document.querySelector(sel)?.innerText?.trim() || "";
        const getAttr = (sel, attr) => document.querySelector(sel)?.getAttribute(attr) || "";

        return {
          name:     getText("h1.DUwDvf") || getText("h1"),
          phone:    getAttr('button[data-item-id^="phone:tel:"]', "data-item-id")?.replace("phone:tel:", "") || getText(".phone"),
          address:  getText('button[data-item-id="address"]'),
          website:  getAttr('a[data-item-id="authority"]', "href"),
          rating:   getText(".F7nice span"),
          category: getText(".DkEaL"),
        };
      });

      if (data.name && data.name !== "Results") results.push(data);
    } catch {}
  }

  return results;
}

async function deepScrapeYellowPages(page, inputData) {
  const { url } = inputData;
  if (!url) return [];

  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  await humanDelay(1500, 3000);

  // Scroll for lazy-load
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 800));
    await humanDelay(800, 1200);
  }

  const results = await page.evaluate(() => {
    return [...document.querySelectorAll(".result, .organic .srp-listing")].map(card => {
      const name    = card.querySelector(".business-name span")?.innerText?.trim() || "";
      const phone   = card.querySelector(".phone, [itemprop='telephone']")?.innerText?.trim() || "";
      const address = [
        card.querySelector(".street-address")?.innerText?.trim(),
        card.querySelector(".locality, .city")?.innerText?.trim(),
        card.querySelector(".region, .state")?.innerText?.trim(),
      ].filter(Boolean).join(", ");
      const category  = card.querySelector(".categories a")?.innerText?.trim() || "";
      const websiteEl = card.querySelector("a.track-visit-website");
      let website = "";
      if (websiteEl) {
        const href = websiteEl.getAttribute("href") || "";
        if (href.includes("aclk")) {
          try {
            const u = new URL(href.startsWith("http") ? href : `https://www.yellowpages.com${href}`);
            website = u.searchParams.get("redirect") || u.searchParams.get("url") || "";
          } catch {}
        } else { website = href; }
      }
      const ratingCls = card.querySelector("[class*='rating']")?.className || "";
      const rm        = ratingCls.match(/rated?-(\d)/i);
      const rating    = rm ? rm[1] : "";

      return { name, phone, address, category, website, rating };
    }).filter(r => r.name);
  });

  return results;
}

// ── Main deep scrape job ──────────────────────────────────────────────────────
export async function runDeepScrape(inputData, userId) {
  const { source, url, leadId, name, proxyUrl } = inputData;

  console.log(`[DeepScrape] Starting: ${source} — ${name || url} ${proxyUrl ? \`(proxy: ${proxyUrl})\` : "(no proxy)"}`);

  const browser = await puppeteer.launch({
    headless:        "new",
    args:            buildLaunchArgs(proxyUrl),  // ← proxy injected here
    defaultViewport: null,
  });

  let results = [];

  try {
    const page = await setupStealthPage(browser);

    switch (source?.toLowerCase()) {
      case "google maps":
      case "google_maps":
        results = await deepScrapeGoogleMaps(page, inputData);
        break;

      case "yellow pages":
      case "yellow_pages":
        results = await deepScrapeYellowPages(page, inputData);
        break;

      default:
        console.warn(`[DeepScrape] No handler for source: ${source}`);
        break;
    }

    console.log(`[DeepScrape] Done: ${results.length} results`);

    // Store results to Supabase
    if (results.length > 0 && userId) {
      const rows = results.map(r => ({
        user_id:      userId,
        source:       source,
        company_name: r.name    || "Unknown",
        phone:        r.phone   || null,
        address:      r.address || null,
        website:      r.website || null,
        category:     r.category || null,
        rating:       r.rating ? parseFloat(r.rating) : null,
        scraped_at:   new Date().toISOString(),
      }));

      const { error } = await supabase
        .from("extension_database")
        .upsert(rows, { onConflict: "hash" });

      if (error) console.error("[DeepScrape] Supabase error:", error.message);
      else       console.log(`[DeepScrape] Stored ${rows.length} leads`);
    }

  } finally {
    await browser.close();
  }

  return { count: results.length, results };
}
