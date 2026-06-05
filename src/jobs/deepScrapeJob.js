/**
 * CompX Worker — src/jobs/deepScrapeJob.js
 * Unified scraper: Google Maps, Yellow Pages, LinkedIn, Yelp,
 * Facebook Business, Amazon Seller, Clutch, G2, Instagram
 *
 * Singleton browser — একটাই browser instance সব job share করে
 */

import puppeteer from "puppeteer";
import { supabase } from "../config/supabase.js";

// ── Singleton Browser ─────────────────────────────────────────────────────────
let _browser = null;
let _browserUseCount = 0;
const BROWSER_RECYCLE_AFTER = 50; // ৫০ job পর browser restart

async function getBrowser(proxyUrl) {
  if (_browser && _browserUseCount < BROWSER_RECYCLE_AFTER) {
    try {
      // Still alive?
      await _browser.pages();
      _browserUseCount++;
      return _browser;
    } catch {
      _browser = null;
    }
  }

  // Launch new browser
  if (_browser) {
    try { await _browser.close(); } catch {}
  }

  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--disable-web-security",
    "--disable-features=IsolateOrigins,site-per-process",
    "--window-size=1366,768",
    "--disable-dev-shm-usage",
    "--disable-gpu",
  ];

  if (proxyUrl) args.push(`--proxy-server=${proxyUrl}`);

  _browser = await puppeteer.launch({
    headless: "new",
    args,
    defaultViewport: null,
  });

  _browserUseCount = 1;
  console.log("[Browser] New browser instance launched");
  return _browser;
}

// ── Anti-bot helpers ──────────────────────────────────────────────────────────
const humanDelay = (min = 800, max = 2500) =>
  new Promise(r => setTimeout(r, min + Math.random() * (max - min)));

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
];

async function newStealthPage(browser) {
  const page = await browser.newPage();

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "plugins",   { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    window.chrome = { runtime: {} };
  });

  await page.setUserAgent(USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]);
  await page.setViewport({
    width:  1366 + Math.floor(Math.random() * 100),
    height: 768  + Math.floor(Math.random() * 50),
  });

  await page.setRequestInterception(true);
  page.on("request", req => {
    const type = req.resourceType();
    const url  = req.url();
    if (["image", "font", "media"].includes(type)) return req.abort();
    if (url.includes("doubleclick") || url.includes("googlesyndication")) return req.abort();
    req.continue();
  });

  return page;
}

// ── Platform Scrapers ─────────────────────────────────────────────────────────

async function scrapeGoogleMaps(page, inputData) {
  const { keyword, location, maxResults = 20 } = inputData;
  const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(`${keyword} ${location || ""}`)}`;

  await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 30000 });
  await humanDelay(2000, 4000);

  const feed = await page.$('div[role="feed"]');
  if (feed) {
    for (let i = 0; i < 5; i++) {
      await page.evaluate(el => el.scrollBy(0, 500), feed);
      await humanDelay(1000, 1800);
    }
  }

  const cards = await page.$$('a[href*="/maps/place/"]');
  console.log(`[GoogleMaps] Found ${cards.length} cards`);

  const results = [];
  for (const card of cards.slice(0, maxResults)) {
    try {
      await card.click();
      await humanDelay(1500, 2500);
      const data = await page.evaluate(() => {
        const get  = sel => document.querySelector(sel)?.innerText?.trim() || "";
        const attr = (sel, a) => document.querySelector(sel)?.getAttribute(a) || "";
        return {
          company_name: get("h1.DUwDvf") || get("h1"),
          phone:    attr('[data-item-id^="phone:tel:"]', "data-item-id")?.replace("phone:tel:", "") || "",
          address:  get('[data-item-id="address"]'),
          website:  attr('[data-item-id="authority"]', "href"),
          rating:   get(".F7nice span"),
          category: get(".DkEaL"),
        };
      });
      if (data.company_name && data.company_name !== "Results") results.push(data);
    } catch {}
  }
  return results;
}

async function scrapeYellowPages(page, inputData) {
  const { keyword, location, url } = inputData;
  const targetUrl = url || `https://www.yellowpages.com/search?search_terms=${encodeURIComponent(keyword)}&geo_location_terms=${encodeURIComponent(location || "")}`;

  await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 30000 });
  await humanDelay(1500, 3000);

  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 800));
    await humanDelay(800, 1200);
  }

  return page.evaluate(() =>
    [...document.querySelectorAll(".result, .organic .srp-listing")].map(card => ({
      company_name: card.querySelector(".business-name span")?.innerText?.trim() || "",
      phone:    card.querySelector(".phone, [itemprop='telephone']")?.innerText?.trim() || "",
      address:  [
        card.querySelector(".street-address")?.innerText?.trim(),
        card.querySelector(".locality")?.innerText?.trim(),
        card.querySelector(".region")?.innerText?.trim(),
      ].filter(Boolean).join(", "),
      category: card.querySelector(".categories a")?.innerText?.trim() || "",
      website:  card.querySelector("a.track-visit-website")?.href || "",
    })).filter(r => r.company_name)
  );
}

async function scrapeYelp(page, inputData) {
  const { keyword, location, maxResults = 20 } = inputData;
  const url = `https://www.yelp.com/search?find_desc=${encodeURIComponent(keyword)}&find_loc=${encodeURIComponent(location || "")}`;

  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  await humanDelay(2000, 3500);

  return page.evaluate((max) =>
    [...document.querySelectorAll('[data-testid="serp-ia-card"], .businessName__09f24__EYSZE, h3.css-1agk4wl')].slice(0, max).map(el => {
      const card = el.closest('[data-testid="serp-ia-card"]') || el.parentElement?.parentElement;
      return {
        company_name: el.querySelector("a")?.innerText?.trim() || el.innerText?.trim() || "",
        rating:   card?.querySelector('[aria-label*="star rating"]')?.getAttribute("aria-label")?.match(/[\d.]+/)?.[0] || "",
        address:  card?.querySelector("address, [class*='secondaryAddress']")?.innerText?.trim() || "",
        category: card?.querySelector('[class*="tag"], [class*="category"]')?.innerText?.trim() || "",
      };
    }).filter(r => r.company_name)
  , maxResults);
}

async function scrapeLinkedIn(page, inputData) {
  const { keyword, location, maxResults = 20 } = inputData;
  const url = `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(keyword)}&origin=GLOBAL_SEARCH_HEADER`;

  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  await humanDelay(3000, 5000);

  return page.evaluate((max) =>
    [...document.querySelectorAll(".entity-result__item, .search-results__result-item")].slice(0, max).map(el => ({
      company_name: el.querySelector(".entity-result__title-text a, .app-aware-link")?.innerText?.trim() || "",
      industry:  el.querySelector(".entity-result__primary-subtitle")?.innerText?.trim() || "",
      size:      el.querySelector(".entity-result__secondary-subtitle")?.innerText?.trim() || "",
      linkedin_url: el.querySelector("a.app-aware-link")?.href || "",
    })).filter(r => r.company_name)
  , maxResults);
}

async function scrapeFacebookBusiness(page, inputData) {
  const { keyword, location, maxResults = 20 } = inputData;
  const url = `https://www.facebook.com/search/pages/?q=${encodeURIComponent(`${keyword} ${location || ""}`)}`;

  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  await humanDelay(3000, 5000);

  return page.evaluate((max) =>
    [...document.querySelectorAll('[data-testid="results"], div[role="feed"] > div')].slice(0, max).map(el => ({
      company_name: el.querySelector("span, a")?.innerText?.trim() || "",
      category:  el.querySelectorAll("span")?.[1]?.innerText?.trim() || "",
    })).filter(r => r.company_name && r.company_name.length > 2)
  , maxResults);
}

async function scrapeAmazonSeller(page, inputData) {
  const { keyword, maxResults = 20 } = inputData;
  const url = `https://www.amazon.com/s?k=${encodeURIComponent(keyword)}&i=merchant-items`;

  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  await humanDelay(2000, 3500);

  return page.evaluate((max) =>
    [...document.querySelectorAll(".s-result-item[data-asin]")].slice(0, max).map(el => ({
      company_name: el.querySelector(".a-profile-name, .s-line-clamp-1")?.innerText?.trim()
        || el.querySelector(".a-size-small.a-color-secondary")?.innerText?.trim() || "",
      asin:    el.getAttribute("data-asin") || "",
      rating:  el.querySelector(".a-icon-alt")?.innerText?.match(/[\d.]+/)?.[0] || "",
      price:   el.querySelector(".a-price .a-offscreen")?.innerText?.trim() || "",
    })).filter(r => r.company_name)
  , maxResults);
}

async function scrapeClutch(page, inputData) {
  const { keyword, maxResults = 20 } = inputData;
  const url = `https://clutch.co/agencies/${encodeURIComponent(keyword.toLowerCase().replace(/\s+/g, "-"))}`;

  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  await humanDelay(2000, 3500);

  return page.evaluate((max) =>
    [...document.querySelectorAll(".provider-row, .provider__inner")].slice(0, max).map(el => ({
      company_name: el.querySelector(".company_info h3, .company-name")?.innerText?.trim() || "",
      website:   el.querySelector("a.website-link, a[href^='http']")?.href || "",
      rating:    el.querySelector(".sg-rating__number")?.innerText?.trim() || "",
      reviews:   el.querySelector(".total-reviews")?.innerText?.trim() || "",
      location:  el.querySelector(".locality")?.innerText?.trim() || "",
    })).filter(r => r.company_name)
  , maxResults);
}

async function scrapeG2(page, inputData) {
  const { keyword, maxResults = 20 } = inputData;
  const url = `https://www.g2.com/search?query=${encodeURIComponent(keyword)}`;

  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  await humanDelay(2000, 3500);

  return page.evaluate((max) =>
    [...document.querySelectorAll(".product-listing, [data-analytics-event-name='product-card']")].slice(0, max).map(el => ({
      company_name: el.querySelector("h3, .product-name")?.innerText?.trim() || "",
      rating:    el.querySelector(".fw-semibold")?.innerText?.trim() || "",
      reviews:   el.querySelector(".reviews-count")?.innerText?.trim() || "",
      category:  el.querySelector(".product-category")?.innerText?.trim() || "",
    })).filter(r => r.company_name)
  , maxResults);
}

async function scrapeInstagramBusiness(page, inputData) {
  const { keyword, maxResults = 20 } = inputData;
  const url = `https://www.instagram.com/explore/tags/${encodeURIComponent(keyword.replace(/\s+/g, ""))}`;

  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  await humanDelay(3000, 5000);

  return page.evaluate((max) =>
    [...document.querySelectorAll("article a, ._aagw")].slice(0, max).map(el => ({
      company_name: el.querySelector("img")?.alt?.split("photo")[0]?.trim() || "",
      instagram_url: el.href || el.querySelector("a")?.href || "",
    })).filter(r => r.company_name)
  , maxResults);
}

// ── Main Entry ────────────────────────────────────────────────────────────────
export async function runDeepScrape(inputData, userId) {
  const source = (inputData?.source || "google_maps").toLowerCase().replace(/-/g, "_");
  const { proxyUrl } = inputData;

  console.log(`[DeepScrape] ▶ source="${source}" user=${userId}`);

  const browser = await getBrowser(proxyUrl);
  const page    = await newStealthPage(browser);
  let results   = [];

  try {
    switch (source) {
      case "google_maps":
      case "google-maps-scrape":
      case "discover_scrape":
      case "scrape":
        results = await scrapeGoogleMaps(page, inputData); break;

      case "yellow_pages":
      case "yellow-pages-scrape":
        results = await scrapeYellowPages(page, inputData); break;

      case "yelp":
      case "yelp-scrape":
        results = await scrapeYelp(page, inputData); break;

      case "linkedin":
      case "linkedin-scrape":
        results = await scrapeLinkedIn(page, inputData); break;

      case "facebook_biz":
      case "facebook-biz-scrape":
        results = await scrapeFacebookBusiness(page, inputData); break;

      case "amazon_seller":
      case "amazon-seller-scrape":
        results = await scrapeAmazonSeller(page, inputData); break;

      case "clutch":
      case "clutch-scrape":
        results = await scrapeClutch(page, inputData); break;

      case "g2":
      case "g2-scrape":
        results = await scrapeG2(page, inputData); break;

      case "instagram_biz":
      case "instagram-biz-scrape":
        results = await scrapeInstagramBusiness(page, inputData); break;

      default:
        console.warn(`[DeepScrape] No handler for source: "${source}"`);
    }

    console.log(`[DeepScrape] ✅ Done — ${results.length} results`);

    // Store to Supabase
    if (results.length > 0 && userId) {
      const rows = results
        .filter(r => r.company_name)
        .map(r => ({
          user_id:      userId,
          source,
          company_name: r.company_name || "Unknown",
          phone:        r.phone   || null,
          address:      r.address || null,
          website:      r.website || null,
          category:     r.category || null,
          rating:       r.rating  ? parseFloat(r.rating) : null,
          linkedin_url: r.linkedin_url || null,
          scraped_at:   Date.now(),
          created_at:   new Date().toISOString(),
        }));

      if (rows.length > 0) {
        const { error } = await supabase
          .from("extension_database")
          .upsert(rows, { onConflict: "hash", ignoreDuplicates: true });
        if (error) console.error("[DeepScrape] Supabase error:", error.message);
        else console.log(`[DeepScrape] Stored ${rows.length} leads`);
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  return { count: results.length, results, source };
}
