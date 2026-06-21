/**
 * CompX — discoverScrapeJob.js
 * Platform Source routing: Google Maps | LinkedIn | Websites | Startup DB
 * Enrichment: Website (Firecrawl multi-page) | Email (Apollo) | Pattern fallback
 */

import FirecrawlApp from "@mendable/firecrawl-js";
import { supabase } from "../config/supabase.js";
import { saveToDatabaseLeads } from "./pipelineSave.js";

const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY || "dummy_key_for_dev_mode" });

// ── Terminal logger ───────────────────────────────────────────────────────────
async function logToTerminal(jobId, message) {
  console.log(`[DiscoverScrape ${jobId}] ${message}`);
  try {
    const { data } = await supabase.from("jobs").select("terminal_logs").eq("id", jobId).single();
    const logs = data?.terminal_logs || [];
    logs.push({ time: new Date().toISOString(), message });
    await supabase.from("jobs").update({ terminal_logs: logs }).eq("id", jobId);
  } catch (e) {}
}

// ── Credit Deduction ──────────────────────────────────────────────────────────
async function deductUserCredits(userId, amount) {
  const { data, error } = await supabase.rpc("deduct_credits_atomic", {
    user_id: userId,
    amount: amount
  });
  if (error || !data) throw new Error("INSUFFICIENT_CREDITS");
  return data;
}

// ── Pattern Email Prediction ──────────────────────────────────────────────────
function predictEmail(name, website) {
  if (!name || !website) return null;
  const domain = (() => { try { return new URL(website).hostname.replace("www.", ""); } catch { return null; } })();
  if (!domain) return null;

  const names = name.split(" ").map(n => n.toLowerCase().replace(/[^a-z]/g, "")).filter(Boolean);
  if (names.length === 0) return `info@${domain}`;

  const f = names[0];
  const l = names.length > 1 ? names[names.length - 1] : "";

  const patterns = [
    { email: `info@${domain}`, score: 0.2 },
    { email: `contact@${domain}`, score: 0.2 },
    { email: `${f}@${domain}`, score: 0.3 },
  ];
  if (l) {
    patterns.push({ email: `${f}.${l}@${domain}`, score: 0.5 });
    patterns.push({ email: `${f[0]}${l}@${domain}`, score: 0.4 });
  }
  patterns.sort((a, b) => b.score - a.score);
  return patterns[0].email;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function extractEmails(text = "") {
  const matches = text.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi);
  const fake = /example\.|test\.|noreply\.|placeholder\.|@sentry\.|@2x\.|\.png|\.jpg|\.gif/i;
  return matches ? [...new Set(matches)].filter(e => !fake.test(e)) : [];
}

function cleanPhone(phone = "") {
  if (!phone) return null;
  const cleaned = phone.replace(/[^\d+]/g, "");
  if (cleaned.startsWith("880")) return `+${cleaned}`;
  if (cleaned.length >= 7) return cleaned;
  return null;
}

function detectHiring(text = "") {
  const lower = text.toLowerCase();
  return ["we're hiring", "we are hiring", "join our team", "open positions",
    "careers", "job openings", "greenhouse.io", "lever.co", "workable.com"
  ].some(kw => lower.includes(kw));
}

function calcScore(lead) {
  let score = 30;

  // YouTube subscriber bonus
  if (lead.source === "youtube") {
    const subs = parseInt(lead.subscriberCount || "0");
    if      (subs >= 1000000) score += 30;
    else if (subs >= 100000)  score += 20;
    else if (subs >= 10000)   score += 10;
    else if (subs >= 1000)    score += 5;
  }

  if (lead.source === "instagram" || lead.source === "instagram_biz") {
    const followers = parseInt(lead.followersCount || "0");
    if      (followers >= 1000000) score += 30;
    else if (followers >= 100000)  score += 20;
    else if (followers >= 10000)   score += 10;
    else if (followers >= 1000)    score += 5;
    if (lead.isVerified)        score += 10;
    if (lead.isBusinessAccount) score += 10;
  }

  if (lead.website)  score += 15;
  if (lead.phone)    score += 15;
  if (lead.email)    score += 25;
  if (lead.rating && parseFloat(lead.rating) >= 4.0) score += 10;
  if (lead.isHiring) score += 20;
  if (lead.linkedin) score += 10;
  return Math.min(99, score);
}

function isScrapable(url = "") {
  const blocked = ["facebook.com", "instagram.com", "twitter.com", "linkedin.com", "youtube.com", "tiktok.com"];
  return !blocked.some(b => url.includes(b));
}

const SERPER_KEY  = () => process.env.SERPER_API_KEY;
const SERPAPI_KEY = () => process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY;

// ── Serper.dev helper (primary) ───────────────────────────────────────────────
async function serperSearch(type, query, num = 10) {
  const key = SERPER_KEY();
  if (!key) return null;

  const endpoints = {
    google:       "https://google.serper.dev/search",
    google_maps:  "https://google.serper.dev/maps",
    images:       "https://google.serper.dev/images",
    news:         "https://google.serper.dev/news",
  };

  const endpoint = endpoints[type] || endpoints.google;
  const res  = await fetch(endpoint, {
    method:  "POST",
    headers: { "X-API-KEY": key, "Content-Type": "application/json" },
    body:    JSON.stringify({ q: query, num }),
  });
  const json = await res.json();
  if (json.error) return null;
  return json;
}

// ════════════════════════════════════════════════════════════════════════════
// PLATFORM SOURCE FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════

// ── 1. Google Maps Source ────────────────────────────────────────────────────
async function searchGoogleMaps(keyword, location, maxResults, jobId) {
  // Primary: Google Maps API
  const gmKey = process.env.GOOGLE_MAPS_API_KEY;
  if (gmKey) {
    try {
      const query = location ? `${keyword} in ${location}` : keyword;
      const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${gmKey}`;
      const res  = await fetch(url);
      const json = await res.json();

      if (json.status !== "REQUEST_DENIED" && json.status !== "OVER_QUERY_LIMIT" && json.results?.length > 0) {
        await logToTerminal(jobId, `Google Maps API: ${json.results.length} results ✅`);
        const results = json.results.slice(0, maxResults).map(place => ({
          id: `map_${place.place_id}`, name: place.name,
          address: place.formatted_address, rating: place.rating?.toString() || "",
          industry: place.types?.[0]?.replace(/_/g, " ") || "",
          website: null, phone: null, email: null, placeId: place.place_id,
          linkedin: null, source: "google_maps",
        }));
        for (const lead of results) {
          if (lead.placeId) {
            const dUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${lead.placeId}&fields=website,formatted_phone_number&key=${gmKey}`;
            const dRes = await fetch(dUrl);
            const dJson = await dRes.json();
            lead.website = dJson.result?.website || null;
            lead.phone   = dJson.result?.formatted_phone_number || null;
          }
        }
        return results;
      }
    } catch (err) {
      await logToTerminal(jobId, `Google Maps API error: ${err.message}`);
    }
  }

  // Primary: Serper.dev google_maps
  const query = location ? `${keyword} in ${location}` : keyword;
  await logToTerminal(jobId, `Trying Serper.dev (google_maps)...`);
  const serperData = await serperSearch("google_maps", query, maxResults);
  if (serperData) {
    const places = serperData.places || [];
    await logToTerminal(jobId, `Serper.dev google_maps: ${places.length} results ✅`);
    if (places.length > 0) {
      return places.slice(0, maxResults).map(p => ({
        id: `serper_${p.cid || Math.random()}`, name: p.title || "",
        address: p.address || "", rating: p.rating?.toString() || "",
        industry: p.category || keyword || "", website: p.website || null,
        phone: p.phoneNumber || null, email: null, linkedin: null, source: "google_maps",
      })).filter(r => r.name);
    }
  }

  // Fallback: SerpAPI google_maps engine
  await logToTerminal(jobId, `Falling back to SerpAPI (google_maps)...`);
  const sKey = SERPAPI_KEY();
  if (!sKey) return [];

  const serpUrl = `https://serpapi.com/search.json?engine=google_maps&q=${encodeURIComponent(query)}&api_key=${sKey}&num=${maxResults}`;
  const res  = await fetch(serpUrl);
  const json = await res.json();
  if (json.error) { await logToTerminal(jobId, `SerpAPI error: ${json.error}`); return []; }
  const places = json.local_results || [];
  await logToTerminal(jobId, `SerpAPI google_maps: ${places.length} results`);
  return places.slice(0, maxResults).map(p => ({
    id: `serp_${p.place_id || Math.random()}`, name: p.title || "",
    address: p.address || "", rating: p.rating?.toString() || "",
    industry: p.type || keyword || "", website: p.website || null,
    phone: p.phone || null, email: null, linkedin: null, source: "google_maps",
  })).filter(r => r.name);
}

// ── 2. LinkedIn Source ───────────────────────────────────────────────────────
function parseLinkedInProfileTitle(title = "") {
  const cleaned = title.replace(/\s*[|\-–—]\s*LinkedIn.*$/i, "").trim();
  const parts = cleaned.split(/\s*[|\-–—@]\s*/);
  const fullName = parts[0]?.trim() || cleaned;
  const rest = parts.slice(1).join(" - ").trim();
  let contactTitle = rest;
  let company = null;
  const atMatch = rest.match(/^(.+?)\s+at\s+(.+)$/i);
  if (atMatch) {
    contactTitle = atMatch[1].trim();
    company = atMatch[2].trim();
  }
  return { fullName, contactTitle, company };
}

function buildLinkedInQuery(keyword, location, linkedinFilters = {}) {
  const titles = [
    ...(linkedinFilters.jobTitles || []),
    ...(linkedinFilters.targetAudiences || []),
  ].slice(0, 10);

  const companyTypes = (linkedinFilters.companyTypes || []).slice(0, 4);
  const employeeHint = (linkedinFilters.employeeSizes || []).join(" ");
  const legalHint = (linkedinFilters.companyLegalTypes || []).slice(0, 2).join(" ");

  if (titles.length > 0) {
    const titlePart = titles.map(t => `"${t}"`).join(" OR ");
    const companyPart = companyTypes.length ? `(${companyTypes.join(" OR ")})` : "";
    const metaPart = [employeeHint, legalHint].filter(Boolean).join(" ");
    return `(${titlePart}) ${companyPart} ${metaPart} site:linkedin.com/in ${location}`.replace(/\s+/g, " ").trim();
  }

  return location
    ? `${keyword} ${location} site:linkedin.com/in OR site:linkedin.com/company`
    : `${keyword} site:linkedin.com/in OR site:linkedin.com/company`;
}

async function searchLinkedIn(keyword, location, maxResults, jobId, linkedinFilters = {}) {
  const query = buildLinkedInQuery(keyword, location, linkedinFilters);
  const searchPeople = (linkedinFilters.jobTitles?.length || linkedinFilters.targetAudiences?.length);

  await logToTerminal(jobId, `LinkedIn query: ${query}`);

  // Primary: Serper.dev
  await logToTerminal(jobId, `Searching LinkedIn via Serper.dev (${searchPeople ? "people" : "companies"})...`);
  const serperData = await serperSearch("google", query, maxResults);
  if (serperData) {
    const organicResults = serperData.organic || [];
    await logToTerminal(jobId, `Serper.dev LinkedIn: ${organicResults.length} results ✅`);
    if (organicResults.length > 0) {
      return organicResults.slice(0, maxResults).map(r => {
        const isProfile = r.link?.includes("linkedin.com/in/");
        if (isProfile) {
          const { fullName, contactTitle, company } = parseLinkedInProfileTitle(r.title || "");
          return {
            id: `li_${Math.random().toString(36).slice(2, 9)}`,
            name: company || fullName,
            contactName: fullName,
            contactTitle: contactTitle || keyword,
            address: location || "",
            rating: "",
            industry: contactTitle || keyword,
            website: null,
            phone: null,
            email: null,
            linkedin: r.link || null,
            snippet: r.snippet || "",
            source: "linkedin",
            linkedinFilters,
          };
        }
        const linkedinMatch = r.link?.match(/linkedin\.com\/company\/([\w-]+)/);
        const companySlug   = linkedinMatch?.[1] || "";
        const companyName   = r.title?.replace(/ \| LinkedIn$/, "").replace(/ - LinkedIn$/, "").trim() || companySlug;
        return {
          id: `li_${companySlug || Math.random()}`,
          name: companyName,
          address: location || "",
          rating: "",
          industry: keyword,
          website: null,
          phone: null,
          email: null,
          linkedin: r.link || null,
          snippet: r.snippet || "",
          source: "linkedin",
          linkedinFilters,
        };
      }).filter(r => r.name || r.contactName);
    }
  }

  // Fallback: SerpAPI
  await logToTerminal(jobId, `Falling back to SerpAPI (LinkedIn)...`);
  const sKey = SERPAPI_KEY();
  if (!sKey) { await logToTerminal(jobId, `No SerpAPI key for LinkedIn search`); return []; }

  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&api_key=${sKey}&num=${maxResults}`;
  const res  = await fetch(url);
  const json = await res.json();

  if (json.error) { await logToTerminal(jobId, `SerpAPI LinkedIn error: ${json.error}`); return []; }

  const organicResults = json.organic_results || [];
  await logToTerminal(jobId, `SerpAPI LinkedIn: ${organicResults.length} results`);

  return organicResults.slice(0, maxResults).map(r => {
    const isProfile = r.link?.includes("linkedin.com/in/");
    if (isProfile) {
      const { fullName, contactTitle, company } = parseLinkedInProfileTitle(r.title || "");
      return {
        id: `li_${Math.random().toString(36).slice(2, 9)}`,
        name: company || fullName,
        contactName: fullName,
        contactTitle: contactTitle || keyword,
        address: location || "",
        industry: contactTitle || keyword,
        website: null, phone: null, email: null,
        linkedin: r.link || null,
        snippet: r.snippet || "",
        source: "linkedin",
        linkedinFilters,
      };
    }
    const linkedinMatch = r.link?.match(/linkedin\.com\/company\/([\w-]+)/);
    const companySlug   = linkedinMatch?.[1] || "";
    const companyName   = r.title?.replace(/ \| LinkedIn$/, "").replace(/ - LinkedIn$/, "").trim() || companySlug;
    return {
      id:       `li_${companySlug || Math.random()}`,
      name:     companyName,
      address:  location || "",
      industry: keyword,
      website:  null, phone: null, email: null,
      linkedin: r.link || null,
      snippet:  r.snippet || "",
      source:   "linkedin",
      linkedinFilters,
    };
  }).filter(r => r.name || r.contactName);
}

// ── 3. Websites Source ───────────────────────────────────────────────────────
async function searchWebsites(keyword, location, maxResults, jobId) {
  const query = location ? `${keyword} ${location}` : keyword;

  // Primary: Serper.dev
  await logToTerminal(jobId, `Searching websites via Serper.dev (Google)...`);
  const serperData = await serperSearch("google", query, maxResults);
  if (serperData) {
    const results = serperData.organic || [];
    await logToTerminal(jobId, `Serper.dev websites: ${results.length} results ✅`);
    if (results.length > 0) {
      return results.slice(0, maxResults).map(r => ({
        id: `web_${Math.random()}`, name: r.title?.trim() || r.displayedLink || "",
        address: location || "", rating: "", industry: keyword,
        website: r.link || null, phone: null, email: null, linkedin: null,
        snippet: r.snippet || "", source: "websites",
      })).filter(r => r.name && r.website);
    }
  }

  // Fallback: SerpAPI
  await logToTerminal(jobId, `Falling back to SerpAPI (websites)...`);
  const sKey = SERPAPI_KEY();
  if (!sKey) { await logToTerminal(jobId, `No SerpAPI key for website search`); return []; }

  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&api_key=${sKey}&num=${maxResults}`;
  const res  = await fetch(url);
  const json = await res.json();

  if (json.error) { await logToTerminal(jobId, `SerpAPI error: ${json.error}`); return []; }

  const results = json.organic_results || [];
  await logToTerminal(jobId, `SerpAPI websites: ${results.length} results`);

  return results.slice(0, maxResults).map(r => ({
    id:       `web_${Math.random()}`,
    name:     r.title?.trim() || r.displayed_link || "",
    address:  location || "",
    rating:   "",
    industry: keyword,
    website:  r.link || null,
    phone:    null,
    email:    null,
    linkedin: null,
    snippet:  r.snippet || "",
    source:   "websites",
  })).filter(r => r.name && r.website);
}

// ── 4. Startup DB Source ─────────────────────────────────────────────────────
async function searchStartupDB(keyword, location, maxResults, jobId) {
  const query = location
    ? `${keyword} ${location} site:crunchbase.com OR site:angel.co`
    : `${keyword} startup site:crunchbase.com OR site:angel.co`;

  // Primary: Serper.dev
  await logToTerminal(jobId, `Searching Startup DB via Serper.dev...`);
  const serperData = await serperSearch("google", query, maxResults);
  if (serperData) {
    const results = serperData.organic || [];
    await logToTerminal(jobId, `Serper.dev Startup DB: ${results.length} results ✅`);
    if (results.length > 0) {
      return results.slice(0, maxResults).map(r => ({
        id: `startup_${Math.random()}`,
        name: r.title?.replace(/ - Crunchbase.*/, "").replace(/ \| AngelList.*/, "").trim() || "",
        address: location || "", rating: "", industry: keyword,
        website: null, phone: null, email: null, linkedin: null,
        crunchbase: r.link?.includes("crunchbase.com") ? r.link : null,
        snippet: r.snippet || "", source: "startup_db",
      })).filter(r => r.name);
    }
  }

  // Fallback: SerpAPI
  await logToTerminal(jobId, `Falling back to SerpAPI (Startup DB)...`);
  const sKey = SERPAPI_KEY();
  if (!sKey) return [];

  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&api_key=${sKey}&num=${maxResults}`;
  const res  = await fetch(url);
  const json = await res.json();

  if (json.error) return [];

  const results = json.organic_results || [];
  await logToTerminal(jobId, `SerpAPI Startup DB: ${results.length} results`);

  return results.slice(0, maxResults).map(r => ({
    id:       `startup_${Math.random()}`,
    name:     r.title?.replace(/ - Crunchbase.*/, "").replace(/ \| AngelList.*/, "").trim() || "",
    address:  location || "",
    rating:   "",
    industry: keyword,
    website:  null,
    phone:    null,
    email:    null,
    linkedin: null,
    crunchbase: r.link?.includes("crunchbase.com") ? r.link : null,
    snippet:  r.snippet || "",
    source:   "startup_db",
  })).filter(r => r.name);
}

// ── 5. YouTube Source ────────────────────────────────────────────────────────
async function searchYouTube(keyword, location, maxResults, jobId, enrichments = {}) {
  // Force disable About page scraping until proxy is configured
  enrichments = { ...enrichments, email: false };

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    await logToTerminal(jobId, `[ERROR] YOUTUBE_API_KEY not set`);
    return [];
  }
 
  // ── Step 1: YouTube Data API v3 — channel search (100 quota units) ─────────
  await logToTerminal(jobId, `YouTube API search: "${keyword}" ${location || ""}...`);
 
  const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
  searchUrl.searchParams.set("part", "snippet");
  searchUrl.searchParams.set("q", location ? `${keyword} ${location}` : keyword);
  searchUrl.searchParams.set("type", "channel");
  searchUrl.searchParams.set("maxResults", String(Math.min(maxResults, 50)));
  searchUrl.searchParams.set("key", apiKey);
 
  const searchRes  = await fetch(searchUrl.toString());
  const searchJson = await searchRes.json();
 
  if (searchJson.error) {
    await logToTerminal(jobId, `YouTube search error: ${searchJson.error.message}`);
    return [];
  }
 
  const items = searchJson.items || [];
  if (items.length === 0) {
    await logToTerminal(jobId, `YouTube: no channels found`);
    return [];
  }
  await logToTerminal(jobId, `YouTube: ${items.length} channels found ✅`);
 
  // ── Step 2: YouTube Data API v3 — bulk channel details (1 quota unit) ──────
  const channelIds = items.map(i => i.snippet.channelId).join(",");
  const detailUrl  = new URL("https://www.googleapis.com/youtube/v3/channels");
  detailUrl.searchParams.set("part", "snippet,statistics");
  detailUrl.searchParams.set("id", channelIds);
  detailUrl.searchParams.set("key", apiKey);
 
  const detailRes  = await fetch(detailUrl.toString());
  const detailJson = await detailRes.json();
 
  if (detailJson.error) {
    await logToTerminal(jobId, `YouTube details error: ${detailJson.error.message}`);
    return [];
  }
 
  const channels = detailJson.items || [];
  await logToTerminal(jobId, `YouTube: details fetched for ${channels.length} channels`);
 
  // Build lead objects — same shape as other sources
  // YouTube-specific fields go into `raw` automatically via pipelineSave
  const results = channels.map(ch => ({
    id:              `yt_${ch.id}`,
    name:            ch.snippet?.title || "",
    company:         ch.snippet?.title || "",
    industry:        keyword,
    address:         location || ch.snippet?.country || "",
    rating:          "",
    website:         null,
    phone:           null,
    email:           null,
    linkedin:        null,
    source:          "youtube",
    // YouTube-specific (saved to `raw` column in leads_staging)
    channelId:       ch.id,
    channelUrl:      `https://www.youtube.com/channel/${ch.id}`,
    subscriberCount: ch.statistics?.subscriberCount  || "0",
    videoCount:      ch.statistics?.videoCount       || "0",
    viewCount:       ch.statistics?.viewCount        || "0",
    joinedDate:      ch.snippet?.publishedAt         || null,
    description:     ch.snippet?.description         || "",
    country:         ch.snippet?.country             || null,
  }));
 
  // ── Step 3: Playwright scrape About page (email enrichment enabled হলে) ────
  // enrichments.email === true হলেই scrape করবে — quota বাঁচাতে
  if (enrichments.email) {
    await logToTerminal(jobId, `Starting YouTube About page scraping...`);
 
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
 
    for (const ch of results) {
      try {
        const aboutUrl = `${ch.channelUrl}/about`;
        await logToTerminal(jobId, `Scraping: ${ch.name} → ${aboutUrl}`);
 
        const page = await context.newPage();
        await page.goto(aboutUrl, { waitUntil: "networkidle", timeout: 20000 });
        await page.waitForTimeout(2000); // rate limit buffer
 
        const text = await page.evaluate(() => document.body.innerText);
 
        // Email extract — reuse same pattern as existing extractEmails()
        const emails = extractEmails(text);
        if (emails[0]) {
          ch.email = emails[0];
          await logToTerminal(jobId, `✉ Email found: ${ch.email}`);
        }
 
        // Phone
        const phoneMatch = text.match(/(\+?[\d][\d\s\-().]{6,}[\d])/);
        if (phoneMatch) ch.phone = cleanPhone(phoneMatch[0]);
 
        // Social links
        const links = await page.evaluate(() =>
          Array.from(document.querySelectorAll("a[href]")).map(a => a.href)
        );
        ch.instagram   = links.find(l => l.includes("instagram.com/")) || null;
        ch.twitter     = links.find(l => l.includes("twitter.com/") || l.includes("x.com/")) || null;
        ch.websiteLink = links.find(l =>
          l && !l.includes("youtube.com") && !l.includes("google.com") &&
          !l.includes("instagram.com") && !l.includes("twitter.com") &&
          l.startsWith("http")
        ) || null;
 
        // Linked website overrides channel URL
        if (ch.websiteLink) ch.website = ch.websiteLink;
 
        await page.close();
      } catch (err) {
        await logToTerminal(jobId, `About scrape failed for ${ch.name}: ${err.message}`);
      }
    }
 
    await browser.close();
  }
 
  return results;
}

// ── 6. Instagram Source ──────────────────────────────────────────────────────
// Two-step Apify approach:
//   Step A → apify/instagram-hashtag-scraper  : keyword → post owners (usernames)
//   Step B → apify/instagram-profile-scraper  : usernames → full profile + contact info

// ── Apify actor runner (generic) ──────────────────────────────────────────────
async function runApifyActor(actorId, input, apifyToken, jobId, timeoutMs = 120000) {
  // Start run
  const runRes = await fetch(
    `https://api.apify.com/v2/acts/${actorId}/runs?token=${apifyToken}`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(input),
    }
  );
  const runJson = await runRes.json();
  if (!runJson?.data?.id) {
    await logToTerminal(jobId, `[Apify] Failed to start ${actorId}: ${JSON.stringify(runJson)}`);
    return null;
  }

  const runId       = runJson.data.id;
  const datasetId   = runJson.data.defaultDatasetId;
  await logToTerminal(jobId, `[Apify] ${actorId} run started: ${runId}`);

  // Poll until SUCCEEDED / FAILED / timeout
  const pollInterval = 5000;
  const maxAttempts  = Math.ceil(timeoutMs / pollInterval);
  let status = "RUNNING";

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, pollInterval));
    const statusRes  = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${apifyToken}`
    );
    const statusJson = await statusRes.json();
    status = statusJson?.data?.status || "FAILED";
    await logToTerminal(jobId, `[Apify] ${actorId} status: ${status} (${(i + 1) * 5}s)`);

    if (status === "SUCCEEDED") break;
    if (status === "FAILED" || status === "ABORTED" || status === "TIMED-OUT") {
      await logToTerminal(jobId, `[Apify] ${actorId} ended with: ${status}`);
      return null;
    }
  }

  if (status !== "SUCCEEDED") {
    await logToTerminal(jobId, `[Apify] ${actorId} timeout after ${timeoutMs / 1000}s`);
    return null;
  }

  // Fetch dataset items
  const dataRes  = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}&clean=true`
  );
  const dataJson = await dataRes.json();
  return Array.isArray(dataJson) ? dataJson : (dataJson?.items || []);
}

async function searchInstagram(keyword, location, maxResults, jobId) {
  const apifyToken = process.env.APIFY_API_TOKEN;
  if (!apifyToken) {
    await logToTerminal(jobId, `[ERROR] APIFY_API_TOKEN not set`);
    return [];
  }

  try {
    // ── Step A: Hashtag Scraper → collect unique post-owner usernames ─────────
    // Actor expects plain word — NO # prefix, NO spaces/special chars
    const hashtag = keyword
      .split(/[\s/,#]+/)
      .filter(Boolean)[0]
      ?.toLowerCase()
      .replace(/[^a-z0-9_]/g, ""); // strip anything not alphanumeric/underscore

    if (!hashtag) {
      await logToTerminal(jobId, `[Instagram] Could not derive valid hashtag from keyword: "${keyword}"`);
      return [];
    }

    await logToTerminal(jobId, `[Instagram] Step A — Hashtag scraper: #${hashtag}`);

    const hashtagItems = await runApifyActor(
      "apify~instagram-hashtag-scraper",
      {
        hashtags:    [hashtag],              // plain word, no # prefix
        resultsLimit: Math.min(maxResults * 5, 100), // over-fetch — many posts per user
      },
      apifyToken,
      jobId,
      90000 // 90s
    );

    if (!hashtagItems || hashtagItems.length === 0) {
      await logToTerminal(jobId, `[Instagram] Step A returned 0 posts — aborting`);
      return [];
    }

    // Deduplicate owners; prefer business accounts when possible
    const usernameMap = new Map(); // username → item
    for (const post of hashtagItems) {
      const owner = post.ownerUsername || post.owner?.username;
      if (!owner || usernameMap.has(owner)) continue;
      usernameMap.set(owner, post);
    }

    const usernames = [...usernameMap.keys()].slice(0, maxResults);
    await logToTerminal(jobId, `[Instagram] Step A done — ${usernames.length} unique owners found ✅`);

    if (usernames.length === 0) return [];

    // ── Step B: Profile Scraper → full profile + contact info ────────────────
    await logToTerminal(jobId, `[Instagram] Step B — Profile scraper for ${usernames.length} accounts`);

    const profileItems = await runApifyActor(
      "apify~instagram-profile-scraper",
      {
        usernames,
      },
      apifyToken,
      jobId,
      120000 // 120s
    );

    if (!profileItems || profileItems.length === 0) {
      await logToTerminal(jobId, `[Instagram] Step B returned 0 profiles — aborting`);
      return [];
    }

    await logToTerminal(jobId, `[Instagram] Step B done — ${profileItems.length} profiles fetched ✅`);

    // ── Map to lead shape (same as other sources) ─────────────────────────────
    return profileItems
      .filter(p => p.username)
      .slice(0, maxResults)
      .map(p => ({
        id:       `ig_${p.id || p.username}`,
        name:     p.fullName || p.username || "",
        company:  p.fullName || p.username || "",
        industry: keyword,
        address:  p.businessAddressJson
                    ? [
                        p.businessAddressJson.street_address,
                        p.businessAddressJson.city_name,
                        p.businessAddressJson.country_code,
                      ].filter(Boolean).join(", ")
                    : location || "",
        rating:   "",
        website:  p.externalUrl || null,
        phone:    p.businessPhoneNumber || null,
        email:    p.businessEmail       || null,
        linkedin: null,
        source:   "instagram",
        // Instagram-specific (saved to `raw` column in leads_staging)
        username:          p.username              || null,
        handle:            `@${p.username}`        || null,
        profileUrl:        `https://www.instagram.com/${p.username}/`,
        followersCount:    p.followersCount        || 0,
        followsCount:      p.followsCount          || 0,
        postsCount:        p.postsCount            || 0,
        bio:               p.biography             || null,
        isVerified:        p.verified              || false,
        isBusinessAccount: p.isBusinessAccount     || false,
        accountType:       p.businessCategoryName  || null,
        igLocation:        p.businessAddressJson   || null,
      }));

  } catch (err) {
    await logToTerminal(jobId, `[Instagram] Error: ${err.message}`);
    return [];
  }
}
 
// ════════════════════════════════════════════════════════════════════════════
// ENRICHMENT FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════

// ── Firecrawl single page ─────────────────────────────────────────────────────
async function scrapeSinglePage(url) {
  try {
    const result = await firecrawl.scrapeUrl(url, { formats: ["markdown"], timeout: 12000 });
    return result?.markdown || "";
  } catch { return ""; }
}

// ── Firecrawl multi-page enrichment ──────────────────────────────────────────
async function enrichWebsite(website, jobId) {
  try {
    if (!isScrapable(website)) {
      await logToTerminal(jobId, `⏭ Skipping social URL: ${website}`);
      return {};
    }

    const hasProto = /^https?:\/\//.test(website);
    const base = hasProto ? website.replace(/\/$/, "") : `https://${website.replace(/\/$/, "")}`;
    const pages = [base, `${base}/contact`, `${base}/contact-us`, `${base}/about`, `${base}/about-us`];

    let allContent = "";
    for (const pageUrl of pages) {
      await logToTerminal(jobId, `Scraping ${pageUrl}...`);
      const content = await scrapeSinglePage(pageUrl);
      allContent += " " + content;
      if (extractEmails(content).length > 0) {
        await logToTerminal(jobId, `✉ Email found on ${pageUrl}`);
        break;
      }
    }

    const emails   = extractEmails(allContent);
    const linkedin = allContent.match(/linkedin\.com\/(?:company|in)\/[\w-]+/)?.[0] || null;
    const twitter  = allContent.match(/twitter\.com\/[\w-]+/)?.[0] || null;

    return {
      email:    emails[0] || null,
      isHiring: detectHiring(allContent),
      linkedin: linkedin ? `https://${linkedin}` : null,
      twitter:  twitter  ? `https://${twitter}`  : null,
      metaDescription: null,
    };
  } catch (err) {
    await logToTerminal(jobId, `Enrichment failed: ${err.message}`);
    return {};
  }
}

// ── Apollo email lookup ───────────────────────────────────────────────────────
async function getEmailFromApollo(companyName, domain, jobId) {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return null;

  try {
    await logToTerminal(jobId, `Apollo lookup: ${companyName}`);
    const res = await fetch("https://api.apollo.io/v1/mixed_people/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
      body: JSON.stringify({
        organization_name: companyName,
        person_titles: ["owner", "founder", "ceo", "director", "manager"],
        per_page: 3,
      }),
    });

    const json   = await res.json();
    const people = json?.people || [];

    for (const person of people) {
      if (person.email && !person.email.includes("email_not_unlocked")) {
        await logToTerminal(jobId, `Apollo found: ${person.email}`);
        return {
          email:        person.email,
          phone:        person.phone_numbers?.[0]?.sanitized_number || null,
          linkedin:     person.linkedin_url || null,
          contactName:  `${person.first_name} ${person.last_name}`.trim(),
          contactTitle: person.title || null,
        };
      }
    }
    return null;
  } catch (err) {
    await logToTerminal(jobId, `Apollo error: ${err.message}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN JOB
// ════════════════════════════════════════════════════════════════════════════
export async function runDiscoverScrape(inputData, userId, job, proxy) {
  const jobId = job.id;
  const {
    keyword,
    location,
    maxResults  = 10,
    source      = "google_maps",
    enrichments = {},
    linkedinFilters = null,
  } = inputData;

  await logToTerminal(jobId, `Starting: "${keyword}" in "${location}" [source: ${source}]`);

  // ── Step 1: Platform Source routing ─────────────────────────────────────────
  let results = [];

  if (source === "linkedin") {
    results = await searchLinkedIn(keyword, location, maxResults, jobId, linkedinFilters || {});
  } else if (source === "websites") {
    results = await searchWebsites(keyword, location, maxResults, jobId);
  } else if (source === "startup_db") {
    results = await searchStartupDB(keyword, location, maxResults, jobId);
  } else if (source === "youtube") {
    results = await searchYouTube(keyword, location, maxResults, jobId, enrichments);
  } else if (source === "instagram" || source === "instagram_biz") {
    results = await searchInstagram(keyword, location, maxResults, jobId);
  } else {
    // default: google_maps
    results = await searchGoogleMaps(keyword, location, maxResults, jobId);
  }

  await logToTerminal(jobId, `Found ${results.length} results from [${source}]`);

  if (results.length === 0) {
    await logToTerminal(jobId, `No results found`);
    return { count: 0, leads: [] };
  }

  // ── Step 2: Enrichment ───────────────────────────────────────────────────────
  await logToTerminal(jobId, `Starting enrichment [website:${!!enrichments.website}, email:${!!enrichments.email}]...`);

  const processedLeads = [];
  let totalCreditsSpent = 0;
  let metrics = { emailsFound: 0, patternPredicted: 0, apolloUsed: 0, skipped: 0 };

  for (const lead of results) {
    let costForLead = 0;

    // Base credit deduction
    try {
      await deductUserCredits(userId, 1);
      costForLead += 1;
    } catch (e) {
      await logToTerminal(jobId, `[STOP] Insufficient credits for ${lead.name}`);
      metrics.skipped++;
      break;
    }

    // Website Enrichment (Firecrawl multi-page)
    if (lead.website && enrichments.website) {
      try {
        await deductUserCredits(userId, 2);
        costForLead += 2;
        const enriched = await enrichWebsite(lead.website, jobId);
        if (!lead.email && enriched.email) { lead.email = enriched.email; metrics.emailsFound++; }
        lead.isHiring = enriched.isHiring || false;
        lead.linkedin = lead.linkedin || enriched.linkedin || null;
        lead.twitter  = enriched.twitter || null;
        lead.metaDescription = enriched.metaDescription || null;
      } catch (e) {
        await logToTerminal(jobId, `[SKIP] Firecrawl credits insufficient for ${lead.name}`);
      }
    }

    // Email Discovery (Apollo → Pattern fallback) — also for LinkedIn phone
    if ((!lead.email && enrichments.email) || (enrichments.phone && !lead.phone)) {
      const domain = lead.website
        ? (() => { try { return new URL(lead.website).hostname.replace("www.", ""); } catch { return null; } })()
        : null;

      const lookupName = lead.contactName || lead.name;

      try {
        if (!lead.email && enrichments.email) {
          await deductUserCredits(userId, 3);
          costForLead += 3;
        }
        const apolloData = await getEmailFromApollo(lookupName, domain, jobId);
        if (apolloData) {
          lead.email        = apolloData.email        || lead.email;
          lead.phone        = apolloData.phone        || lead.phone;
          lead.linkedin     = apolloData.linkedin     || lead.linkedin;
          lead.contactName  = apolloData.contactName  || lead.contactName;
          lead.contactTitle = apolloData.contactTitle || lead.contactTitle;
          if (apolloData.email) { metrics.apolloUsed++; metrics.emailsFound++; }
        } else if (!lead.email && enrichments.email) {
          lead.email = predictEmail(lead.name, lead.website);
          if (lead.email) metrics.patternPredicted++;
        }
      } catch (e) {
        if (!lead.email && enrichments.email) {
          try {
            await deductUserCredits(userId, 1);
            costForLead += 1;
            lead.email = predictEmail(lead.name, lead.website);
            if (lead.email) metrics.patternPredicted++;
            await logToTerminal(jobId, `[LOW CREDITS] Pattern engine used for ${lead.name}`);
          } catch { await logToTerminal(jobId, `[SKIP] Email discovery skipped for ${lead.name}`); }
        }
      }
    }

    lead.score = calcScore(lead);
    await logToTerminal(jobId, `✓ ${lead.name} — email: ${lead.email || "none"}, score: ${lead.score}`);
    processedLeads.push(lead);
    totalCreditsSpent += costForLead;

    // Progress update
    try {
      await job.updateProgress({
        type: "lead.progress",
        lead: { name: lead.name, step: "Enrichment Complete" },
        metrics,
        billing: {
          creditsSpent: parseFloat(totalCreditsSpent.toFixed(2)),
          avgCost: parseFloat((totalCreditsSpent / processedLeads.length).toFixed(2))
        },
        processedCount: processedLeads.length,
        totalCount: results.length,
      });
    } catch {}
  }

  // ── Step 3: DB save ───────────────────────────────────────────────────────────
  await logToTerminal(jobId, `Saving ${processedLeads.length} leads...`);

  if (processedLeads.length > 0) {
    try {
      await saveToDatabaseLeads(processedLeads, userId, inputData.orgId, source);
    } catch (error) {
      await logToTerminal(jobId, `[ERROR] DB save failed: ${error.message}`);
      throw error;
    }
  }

  await logToTerminal(jobId, `✅ Job complete — ${processedLeads.length} leads saved`);
  return { count: processedLeads.length, leads: processedLeads };
}
