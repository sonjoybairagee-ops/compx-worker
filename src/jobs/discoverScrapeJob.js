/**
 * CompX — discoverScrapeJob.js
 * Platform Source routing: Google Maps | LinkedIn | Websites | Startup DB
 * Enrichment: Website (Firecrawl multi-page) | Email (Hunter.io) | Pattern fallback
 */

import FirecrawlApp from "@mendable/firecrawl-js";
import { supabase } from "../config/supabase.js";
import { createLogger } from "../lib/terminalLogger.js";
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
/** Per-lead platform search cost (must match src/lib/credits/discoverCosts.ts) */
const PLATFORM_SCRAPE_COST = {
  google_maps: 3,
  linkedin: 5,
  youtube: 5,
  instagram: 4,
  instagram_biz: 4,
  websites: 3,
  startup_db: 5,
};

/** Enrichment add-ons (must match src/lib/credits/discoverCosts.ts) */
const ENRICHMENT_SCRAPE_COST = {
  website: 2,
  email: 3,
  tech: 1,
  ai: 1,
};

/** Hunter.io API surcharge when lookup runs (must match discoverCosts.ts HUNTER_LOOKUP_COST) */
const HUNTER_LOOKUP_COST = 3;

async function deductUserCredits(userId, amount, orgId) {
  const { error } = await supabase.rpc("deduct_credits", {
    p_user_id: userId,
    p_org_id: orgId || userId,
    p_amount: amount,
  });
  if (error) throw new Error("INSUFFICIENT_CREDITS");
}

async function tryDeductUserCredits(userId, amount, orgId, reason, type) {
  try {
    await deductUserCredits(userId, amount, orgId);
    await logCreditTransaction(userId, orgId, -amount, reason, type);
    return true;
  } catch {
    return false;
  }
}

async function logCreditTransaction(userId, orgId, amount, reason, type, leadName) {
  try {
    await supabase.from("credit_transactions").insert({
      user_id: userId,
      amount,
      reason,
      type,
      lead_id: null,
    });
  } catch (e) {
    console.warn("[DiscoverScrape] credit_transactions log failed:", e.message);
  }
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
async function serperSearch(type, query, num = 10, page = 1) {
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
    body:    JSON.stringify({ q: query, num, page }),
  });
  const json = await res.json();
  if (json.error) return null;
  return json;
}

/** Paginated Serper Maps — fetches up to maxResults (multiple pages if needed) */
async function serperMapsPaginated(query, maxResults, jobId) {
  const all = [];
  const maxPages = Math.ceil(maxResults / 20);

  for (let page = 1; page <= maxPages && all.length < maxResults; page++) {
    const need = Math.min(100, maxResults - all.length);
    const data = await serperSearch("google_maps", query, need, page);
    const places = data?.places || [];
    await logToTerminal(jobId, `Serper maps page ${page}: ${places.length} results`);
    if (!places.length) break;
    all.push(...places);
    if (places.length < need) break; // no more pages available
  }

  return all.slice(0, maxResults);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ════════════════════════════════════════════════════════════════════════════
// PLATFORM SOURCE FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════

// ── 1. Google Maps Source ────────────────────────────────────────────────────
async function searchGoogleMaps(keyword, location, maxResults, jobId) {
  const query = location ? `${keyword} in ${location}` : keyword;

  // Primary: Google Maps Places API (paginated — 20 results/page, up to 60 total)
  const gmKey = process.env.GOOGLE_MAPS_API_KEY;
  if (gmKey) {
    try {
      const allPlaces = [];
      let nextPageToken = null;
      let pageNum = 0;

      while (allPlaces.length < maxResults && pageNum < 5) {
        let url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${gmKey}`;
        if (nextPageToken) url += `&pagetoken=${encodeURIComponent(nextPageToken)}`;

        const res  = await fetch(url);
        const json = await res.json();

        if (json.status === "REQUEST_DENIED" || json.status === "OVER_QUERY_LIMIT") break;
        if (!json.results?.length) break;

        allPlaces.push(...json.results);
        pageNum++;
        await logToTerminal(jobId, `Google Maps API page ${pageNum}: ${json.results.length} (total ${allPlaces.length})`);

        nextPageToken = json.next_page_token || null;
        if (!nextPageToken || allPlaces.length >= maxResults) break;
        // Google requires ~2s delay before using next_page_token
        await sleep(2100);
      }

      if (allPlaces.length > 0) {
        const results = allPlaces.slice(0, maxResults).map(place => ({
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

  // Serper.dev google_maps (paginated)
  await logToTerminal(jobId, `Trying Serper.dev (google_maps, target: ${maxResults})...`);
  const serperPlaces = await serperMapsPaginated(query, maxResults, jobId);
  if (serperPlaces.length > 0) {
    await logToTerminal(jobId, `Serper.dev google_maps: ${serperPlaces.length} total ✅`);
    return serperPlaces.map(p => ({
      id: `serper_${p.cid || Math.random()}`, name: p.title || "",
      address: p.address || "", rating: p.rating?.toString() || "",
      industry: p.category || keyword || "", website: p.website || null,
      phone: p.phoneNumber || null, email: null, linkedin: null, source: "google_maps",
    })).filter(r => r.name);
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

// ── LinkedIn result mapper (shared by Apify + fallbacks) ─────────────────────
function mapLinkedInSerperResult(r, keyword, location, linkedinFilters) {
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
    id: `li_${companySlug || Math.random()}`,
    name: companyName,
    address: location || "",
    industry: keyword,
    website: null, phone: null, email: null,
    linkedin: r.link || null,
    snippet: r.snippet || "",
    source: "linkedin",
    linkedinFilters,
  };
}

async function searchLinkedIn(keyword, location, maxResults, jobId, linkedinFilters = {}) {
  const query = buildLinkedInQuery(keyword, location, linkedinFilters);
  const searchPeople = (linkedinFilters.jobTitles?.length || linkedinFilters.targetAudiences?.length);
  const apifyToken = process.env.APIFY_API_TOKEN;

  await logToTerminal(jobId, `LinkedIn query: ${query}`);

  // ── Primary: Apify LinkedIn scraper ─────────────────────────────────────────
  if (apifyToken) {
    try {
      await logToTerminal(jobId, `[LinkedIn] Apify primary — ${searchPeople ? "people" : "companies"} search`);

      const actorInput = searchPeople
        ? {
            // People search
            searchUrl: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keyword)}${location ? `&location=${encodeURIComponent(location)}` : ""}`,
            count: maxResults,
          }
        : {
            // Company search
            searchUrl: `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(keyword)}${location ? `&location=${encodeURIComponent(location)}` : ""}`,
            count: maxResults,
          };

      const apifyResults = await runApifyActor(
        searchPeople ? "curious_coder~linkedin-people-search-scraper" : "curious_coder~linkedin-company-search-scraper",
        actorInput,
        apifyToken,
        jobId,
        120000
      );

      if (apifyResults && apifyResults.length > 0) {
        await logToTerminal(jobId, `[LinkedIn] Apify: ${apifyResults.length} results ✅`);
        return apifyResults.slice(0, maxResults).map(r => {
          const isProfile = !!(r.firstName || r.lastName || r.profileUrl?.includes("/in/"));
          if (isProfile) {
            return {
              id:           `li_${Math.random().toString(36).slice(2, 9)}`,
              name:         r.companyName || `${r.firstName || ""} ${r.lastName || ""}`.trim(),
              contactName:  `${r.firstName || ""} ${r.lastName || ""}`.trim() || null,
              contactTitle: r.headline || r.title || keyword,
              address:      r.location || location || "",
              industry:     r.industry || keyword,
              website:      null,
              phone:        null,
              email:        r.email || null,
              linkedin:     r.profileUrl || r.url || null,
              snippet:      r.summary || r.about || "",
              source:       "linkedin",
              linkedinFilters,
            };
          }
          return {
            id:       `li_${Math.random().toString(36).slice(2, 9)}`,
            name:     r.name || r.companyName || "",
            address:  r.location || location || "",
            industry: r.industry || keyword,
            website:  r.website || null,
            phone:    null,
            email:    null,
            linkedin: r.linkedinUrl || r.url || null,
            snippet:  r.description || r.about || "",
            source:   "linkedin",
            linkedinFilters,
          };
        }).filter(r => r.name || r.contactName);
      }

      await logToTerminal(jobId, `[LinkedIn] Apify returned 0 results — falling back`);
    } catch (apifyErr) {
      await logToTerminal(jobId, `[LinkedIn] Apify error: ${apifyErr.message} — falling back`);
    }
  }

  // ── Fallback 1: Serper.dev ───────────────────────────────────────────────────
  await logToTerminal(jobId, `[LinkedIn] Serper.dev fallback...`);
  const serperData = await serperSearch("google", query, maxResults);
  if (serperData) {
    const organicResults = serperData.organic || [];
    await logToTerminal(jobId, `[LinkedIn] Serper: ${organicResults.length} results`);
    if (organicResults.length > 0) {
      return organicResults.slice(0, maxResults)
        .map(r => mapLinkedInSerperResult(r, keyword, location, linkedinFilters))
        .filter(r => r.name || r.contactName);
    }
  }

  await logToTerminal(jobId, `[LinkedIn] All sources exhausted — no results`);
  return [];
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
async function searchYouTube(keyword, location, maxResults, jobId, enrichments = {}, youtubeFilters = {}) {
  // Force disable About page scraping until proxy is configured
  enrichments = { ...enrichments, email: false };

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    await logToTerminal(jobId, `[ERROR] YOUTUBE_API_KEY not set`);
    return [];
  }

  // ── Step 1: YouTube Data API v3 — channel search ─────────────────────────
  // Location keyword হিসেবে যোগ করো — YouTube API তে location filter নেই
  const searchQuery = location ? `${keyword} ${location}` : keyword;
  await logToTerminal(jobId, `YouTube API search: "${searchQuery}"...`);

  const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
  searchUrl.searchParams.set("part", "snippet");
  searchUrl.searchParams.set("q", searchQuery);
  searchUrl.searchParams.set("type", "channel");
  searchUrl.searchParams.set("maxResults", String(Math.min(maxResults * 2, 50))); // 2x fetch, filter later
  // Language from filter or default to English
  const langCode = youtubeFilters.language || "en";
  if (langCode) searchUrl.searchParams.set("relevanceLanguage", langCode);
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

  // ── Step 2: YouTube Data API v3 — bulk channel details ──────────────────
  const channelIds = items.map(i => i.snippet.channelId).join(",");
  const detailUrl  = new URL("https://www.googleapis.com/youtube/v3/channels");
  detailUrl.searchParams.set("part", "snippet,statistics,brandingSettings,contentDetails");
  detailUrl.searchParams.set("id", channelIds);
  detailUrl.searchParams.set("key", apiKey);

  const detailRes  = await fetch(detailUrl.toString());
  const detailJson = await detailRes.json();

  if (detailJson.error) {
    await logToTerminal(jobId, `YouTube details error: ${detailJson.error.message}`);
    return [];
  }

  let channels = detailJson.items || [];
  await logToTerminal(jobId, `YouTube: details fetched for ${channels.length} channels`);

  // ── Step 3: Quality filter — youtubeFilters + business signals ──────────────
  const subMin     = parseInt(youtubeFilters.subscriberMin  || "1000");
  const subMax     = youtubeFilters.subscriberMax ? parseInt(youtubeFilters.subscriberMax) : Infinity;
  const minVideos  = parseInt(youtubeFilters.minVideoCount  || "10");
  const onlyWebsite = youtubeFilters.hasWebsite === true || youtubeFilters.hasWebsite === "true";
  const contentType = youtubeFilters.contentType || "any"; // "any"|"longform"|"shorts"|"both"

  await logToTerminal(jobId, `YouTube filters — subs: ${subMin}–${subMax === Infinity ? "∞" : subMax}, minVideos: ${minVideos}, onlyWebsite: ${onlyWebsite}, contentType: ${contentType}`);

  channels = channels.filter(ch => {
    const subs   = parseInt(ch.statistics?.subscriberCount || "0");
    const videos = parseInt(ch.statistics?.videoCount      || "0");
    const desc   = (ch.snippet?.description || "").toLowerCase();

    // Subscriber range filter
    if (subs < subMin) return false;
    if (subs > subMax) return false;

    // Min video count filter
    if (videos < minVideos) return false;

    // Has website filter — description এ http link আছে কিনা
    if (onlyWebsite) {
      const hasWebLink = !!(desc.match(/https?:\/\/(?!youtube\.com|youtu\.be|google\.com|instagram\.com|facebook\.com|twitter\.com|tiktok\.com)[^\s]+/));
      if (!hasWebLink) return false;
    }

    // Content type filter — channel description বা title থেকে guess করা
    if (contentType === "shorts") {
      const shortsSignal = desc.includes("short") || (ch.snippet?.title || "").toLowerCase().includes("short");
      if (!shortsSignal) return false;
    } else if (contentType === "longform") {
      // Shorts-only channels বাদ দাও
      const shortsOnly = (ch.snippet?.title || "").toLowerCase().includes("#shorts") ||
                         (desc.includes("#shorts") && !desc.includes("video") && !desc.includes("tutorial"));
      if (shortsOnly) return false;
    }
    // "both" or "any" = no filter

    // Business signal — description এ contact/business keyword আছে কিনা
    const businessSignals = ["contact", "business", "email", "call", "service",
      "hire", "book", "order", "shop", "buy", "whatsapp", "dm", "enquiry",
      "agency", "studio", "clinic", "school", "academy", "company", "ltd"];
    const hasBusinessSignal = businessSignals.some(s => desc.includes(s));

    // 5000+ subscribers হলে business signal ছাড়াও allow করো
    if (subs >= 5000) return true;
    return hasBusinessSignal;
  });

  // Last upload date filter — videos API দিয়ে check করবো
  const lastUploadDays = youtubeFilters.lastUploadDays ? parseInt(youtubeFilters.lastUploadDays) : null;
  if (lastUploadDays && channels.length > 0) {
    await logToTerminal(jobId, `Checking last upload date (within ${lastUploadDays} days)...`);
    const cutoffDate = new Date(Date.now() - lastUploadDays * 24 * 60 * 60 * 1000).toISOString();

    const activeChannels = [];
    for (const ch of channels) {
      try {
        const recentUrl = new URL("https://www.googleapis.com/youtube/v3/search");
        recentUrl.searchParams.set("part", "snippet");
        recentUrl.searchParams.set("channelId", ch.id);
        recentUrl.searchParams.set("type", "video");
        recentUrl.searchParams.set("order", "date");
        recentUrl.searchParams.set("maxResults", "1");
        recentUrl.searchParams.set("publishedAfter", cutoffDate);
        recentUrl.searchParams.set("key", apiKey);

        const recentRes  = await fetch(recentUrl.toString());
        const recentJson = await recentRes.json();
        if ((recentJson.items || []).length > 0) {
          activeChannels.push(ch);
        }
      } catch {
        activeChannels.push(ch); // error হলে include করো
      }
    }
    channels = activeChannels;
    await logToTerminal(jobId, `YouTube: ${channels.length} active channels (last upload within ${lastUploadDays} days)`);
  }

  // maxResults limit
  channels = channels.slice(0, maxResults);

  await logToTerminal(jobId, `YouTube: ${channels.length} business channels after filter ✅`);

  // Build lead objects
  const results = channels.map(ch => {
    const subs = parseInt(ch.statistics?.subscriberCount || "0");

    // Website link — description থেকে extract করো
    const descLinks = (ch.snippet?.description || "").match(/https?:\/\/[^\s]+/g) || [];
    const websiteFromDesc = descLinks.find(l =>
      !l.includes("youtube.com") && !l.includes("google.com") &&
      !l.includes("instagram.com") && !l.includes("twitter.com") &&
      !l.includes("facebook.com") && !l.includes("tiktok.com")
    ) || null;

    return {
      id:              `yt_${ch.id}`,
      name:            ch.snippet?.title || "",
      company:         ch.snippet?.title || "",
      industry:        keyword,
      address:         location || ch.snippet?.country || "",
      rating:          "",
      website:         websiteFromDesc, // description থেকে website
      phone:           null,
      email:           null,
      linkedin:        null,
      source:          "youtube",
      channelId:       ch.id,
      channelUrl:      `https://www.youtube.com/channel/${ch.id}`,
      subscriberCount: ch.statistics?.subscriberCount  || "0",
      videoCount:      ch.statistics?.videoCount       || "0",
      viewCount:       ch.statistics?.viewCount        || "0",
      joinedDate:      ch.snippet?.publishedAt         || null,
      description:     ch.snippet?.description         || "",
      country:         ch.snippet?.country             || null,
      // Quality metrics
      _subCount:       subs,
    };
  });

  // Sort by subscriber count (bigger = more established business)
  results.sort((a, b) => (b._subCount || 0) - (a._subCount || 0));
 
  // ── Step 3: Playwright scrape About page (email enrichment enabled হলে) ────
  // enrichments.email === true হলেই scrape করবে — quota বাঁচাতে
  if (enrichments.email) {
    await logToTerminal(jobId, `Starting YouTube About page scraping (Playwright + Webshare proxy)...`);

    const { chromium } = await import("playwright");

    // Webshare proxy config
    const proxyUrl      = process.env.WEBSHARE_PROXY_URL || "http://proxy.webshare.io:80";
    const proxyUser     = process.env.WEBSHARE_USERNAME;
    const proxyPass     = process.env.WEBSHARE_PASSWORD;
    const hasProxy      = !!(proxyUser && proxyPass);

    const launchOptions = {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    };

    const contextOptions = {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ...(hasProxy ? {
        proxy: {
          server:   proxyUrl,
          username: proxyUser,
          password: proxyPass,
        }
      } : {}),
    };

    if (!hasProxy) {
      await logToTerminal(jobId, `[YouTube] No Webshare proxy configured — scraping without proxy (may get blocked)`);
    } else {
      await logToTerminal(jobId, `[YouTube] Using Webshare proxy: ${proxyUrl}`);
    }

    const browser = await chromium.launch(launchOptions);
    const context = await browser.newContext(contextOptions);

    for (const ch of results) {
      try {
        const aboutUrl = `${ch.channelUrl}/about`;
        await logToTerminal(jobId, `Scraping: ${ch.name} → ${aboutUrl}`);

        const page = await context.newPage();

        // Block images/fonts to speed up loading
        await page.route("**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}", r => r.abort());

        await page.goto(aboutUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
        await page.waitForTimeout(2500);

        const text = await page.evaluate(() => document.body.innerText);

        // Email
        const emails = extractEmails(text);
        if (emails[0]) {
          ch.email = emails[0];
          await logToTerminal(jobId, `✉ Email found: ${ch.email}`);
        }

        // Phone
        const phoneMatch = text.match(/(\+?[\d][\d\s\-().]{6,}[\d])/);
        if (phoneMatch) ch.phone = cleanPhone(phoneMatch[0]);

        // Social & website links
        const links = await page.evaluate(() =>
          Array.from(document.querySelectorAll("a[href]")).map(a => a.href)
        );

        ch.instagram   = links.find(l => l.includes("instagram.com/") && !l.includes("instagram.com/p/")) || null;
        ch.twitter     = links.find(l => l.includes("twitter.com/") || l.includes("x.com/")) || null;
        ch.facebook    = links.find(l => l.includes("facebook.com/") && !l.includes("facebook.com/sharer")) || null;
        ch.websiteLink = links.find(l =>
          l && l.startsWith("http") &&
          !l.includes("youtube.com") && !l.includes("google.com") &&
          !l.includes("instagram.com") && !l.includes("twitter.com") &&
          !l.includes("facebook.com") && !l.includes("tiktok.com") &&
          !l.includes("t.co")
        ) || null;

        if (ch.websiteLink) ch.website = ch.websiteLink;

        await page.close();
        await new Promise(r => setTimeout(r, 1500)); // rate limit buffer
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
    await logToTerminal(jobId, `[Instagram] Apify error: ${err.message} — trying SerpAPI fallback`);

    // ── SerpAPI Fallback ─────────────────────────────────────────────────────
    try {
      const sKey = SERPAPI_KEY();
      if (!sKey) { await logToTerminal(jobId, `[Instagram] No SerpAPI key — giving up`); return []; }

      const igQuery = location
        ? `${keyword} instagram business ${location}`
        : `${keyword} instagram business`;

      await logToTerminal(jobId, `[Instagram] SerpAPI fallback query: ${igQuery}`);
      const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(igQuery)}&api_key=${sKey}&num=${maxResults}`;
      const res  = await fetch(url);
      const json = await res.json();

      if (json.error) { await logToTerminal(jobId, `[Instagram] SerpAPI error: ${json.error}`); return []; }

      const results = (json.organic_results || [])
        .filter(r => r.link?.includes("instagram.com/"))
        .slice(0, maxResults)
        .map(r => {
          const usernameMatch = r.link.match(/instagram\.com\/([^/?#]+)/);
          const username = usernameMatch?.[1] || "";
          return {
            id:         `ig_${username || Math.random().toString(36).slice(2,8)}`,
            name:       r.title?.replace(/ \(@[^)]+\)/, "").replace(/ • Instagram.*/, "").trim() || username,
            company:    r.title?.replace(/ \(@[^)]+\)/, "").replace(/ • Instagram.*/, "").trim() || username,
            industry:   keyword,
            address:    location || "",
            website:    null,
            phone:      null,
            email:      null,
            source:     "instagram",
            username,
            handle:     `@${username}`,
            profileUrl: `https://www.instagram.com/${username}/`,
            snippet:    r.snippet || "",
            followersCount: 0,
            bio:        r.snippet || null,
          };
        })
        .filter(r => r.username && r.username !== "p" && r.username !== "explore");

      await logToTerminal(jobId, `[Instagram] SerpAPI fallback: ${results.length} results`);
      return results;

    } catch (fallbackErr) {
      await logToTerminal(jobId, `[Instagram] SerpAPI fallback error: ${fallbackErr.message}`);
      return [];
    }
  }
}


// ── 7. Amazon Source ─────────────────────────────────────────────────────────
// SerpAPI Amazon engine — product search + seller info
async function searchAmazon(keyword, location, maxResults, jobId) {
  const sKey = SERPAPI_KEY();
  if (!sKey) {
    await logToTerminal(jobId, `[Amazon] No SerpAPI key — skipping`);
    return [];
  }

  try {
    // Step 1: Product search
    await logToTerminal(jobId, `[Amazon] Searching products: "${keyword}"`);
    const searchUrl = `https://serpapi.com/search.json?engine=amazon&amazon_domain=amazon.com&k=${encodeURIComponent(keyword)}&api_key=${sKey}`;
    const searchRes  = await fetch(searchUrl);
    const searchJson = await searchRes.json();

    if (searchJson.error) {
      await logToTerminal(jobId, `[Amazon] Search error: ${searchJson.error}`);
      return [];
    }

    const products = searchJson.organic_results || searchJson.shopping_results || [];
    await logToTerminal(jobId, `[Amazon] Found ${products.length} products`);

    if (!products.length) return [];

    // Step 2: Enrich each product with seller info
    const results = [];
    for (const product of products.slice(0, maxResults)) {
      try {
        const asin = product.asin;
        let sellerName = product.seller_name || product.brand || null;
        let sellerLink = null;
        let productTitle = product.title || "";
        let productPrice = product.price?.raw || product.price || null;
        let productRating = product.rating || null;
        let productReviews = product.reviews || null;
        let productImage = product.thumbnail || null;

        // If ASIN available, get product details for seller info
        if (asin) {
          const productUrl = `https://serpapi.com/search.json?engine=amazon_product&asin=${asin}&amazon_domain=amazon.com&api_key=${sKey}`;
          const productRes  = await fetch(productUrl);
          const productJson = await productRes.json();

          if (!productJson.error) {
            const info = productJson.product_results || {};
            sellerName    = info.seller_name   || sellerName;
            sellerLink    = info.seller_link   || null;
            productTitle  = info.title         || productTitle;
            productPrice  = info.price?.raw    || productPrice;
            productRating = info.rating        || productRating;
            productReviews = info.reviews      || productReviews;
          }
        }

        results.push({
          id:       `amz_${asin || Math.random().toString(36).slice(2, 8)}`,
          name:     sellerName || productTitle,
          company:  sellerName || productTitle,
          industry: keyword,
          address:  location || "",
          website:  sellerLink || (asin ? `https://www.amazon.com/dp/${asin}` : null),
          phone:    null,
          email:    null,
          source:   "amazon",
          // Amazon-specific
          asin,
          productTitle,
          productPrice,
          productRating,
          productReviews,
          productImage,
          sellerName,
          sellerLink,
          amazonUrl: asin ? `https://www.amazon.com/dp/${asin}` : null,
        });

        await logToTerminal(jobId, `[Amazon] ✅ ${productTitle} — Seller: ${sellerName || "unknown"}`);
      } catch (err) {
        await logToTerminal(jobId, `[Amazon] Product detail error: ${err.message}`);
      }
    }

    await logToTerminal(jobId, `[Amazon] Done — ${results.length} products collected`);
    return results;

  } catch (err) {
    await logToTerminal(jobId, `[Amazon] Error: ${err.message}`);
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

// ── Hunter.io email lookup ────────────────────────────────────────────────────
async function getEmailFromHunter(companyName, domain, jobId) {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) return null;
  if (!domain)  return null;

  try {
    await logToTerminal(jobId, `Hunter.io lookup: ${domain}`);

    // 1. Domain Search — সব emails খোঁজো
    const searchUrl = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=5&api_key=${apiKey}`;
    const searchRes  = await fetch(searchUrl);
    const searchJson = await searchRes.json();

    const emails = searchJson?.data?.emails || [];

    // Owner/founder/CEO priority
    const priorityTitles = ["owner", "founder", "ceo", "director", "manager", "president"];
    const priorityEmail  = emails.find(e =>
      e.position && priorityTitles.some(t => e.position.toLowerCase().includes(t))
    );
    const bestEmail = priorityEmail || emails[0];

    if (bestEmail?.value) {
      await logToTerminal(jobId, `Hunter found: ${bestEmail.value}`);
      return {
        email:        bestEmail.value,
        phone:        null, // Hunter does not return phone
        linkedin:     bestEmail.linkedin || null,
        contactName:  [bestEmail.first_name, bestEmail.last_name].filter(Boolean).join(" ") || null,
        contactTitle: bestEmail.position || null,
        confidence:   bestEmail.confidence || null,
      };
    }

    // 2. Email Finder fallback — domain থেকে best guess
    const finderUrl = `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&company=${encodeURIComponent(companyName)}&api_key=${apiKey}`;
    const finderRes  = await fetch(finderUrl);
    const finderJson = await finderRes.json();

    const found = finderJson?.data;
    if (found?.email) {
      await logToTerminal(jobId, `Hunter finder: ${found.email} (confidence: ${found.score}%)`);
      return {
        email:        found.email,
        phone:        null,
        linkedin:     null,
        contactName:  [found.first_name, found.last_name].filter(Boolean).join(" ") || null,
        contactTitle: found.position || null,
        confidence:   found.score || null,
      };
    }

    await logToTerminal(jobId, `Hunter: no email found for ${domain}`);
    return null;

  } catch (err) {
    await logToTerminal(jobId, `Hunter error: ${err.message}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN JOB
// ════════════════════════════════════════════════════════════════════════════
export async function runDiscoverScrape(inputData, userId, job, proxy) {
  const jobId = job.id;
  const logger = createLogger(jobId);
  const {
    keyword,
    location,
    maxResults  = 10,
    source      = "google_maps",
    enrichments = {},
    linkedinFilters  = null,
    youtubeFilters   = {},
    orgId            = null,
  } = inputData;

  await logger.log(`Starting: "${keyword}" in "${location}" [source: ${source}]`);

  // ── Step 1: Platform Source routing ─────────────────────────────────────────
  let results = [];

  if (source === "linkedin") {
    results = await searchLinkedIn(keyword, location, maxResults, jobId, linkedinFilters || {});
  } else if (source === "websites") {
    results = await searchWebsites(keyword, location, maxResults, jobId);
  } else if (source === "startup_db") {
    results = await searchStartupDB(keyword, location, maxResults, jobId);
  } else if (source === "youtube") {
    results = await searchYouTube(keyword, location, maxResults, jobId, enrichments, inputData.youtubeFilters || {});
  } else if (source === "amazon") {
    results = await searchAmazon(keyword, location, maxResults, jobId);
  } else if (source === "instagram" || source === "instagram_biz") {
    results = await searchInstagram(keyword, location, maxResults, jobId);
  } else {
    // default: google_maps
    results = await searchGoogleMaps(keyword, location, maxResults, jobId);
  }

  await logger.log(`Found ${results.length} results from [${source}]`);

  if (results.length === 0) {
    await logger.log(`No results found`);
    await logger.close();
    return { count: 0, leads: [] };
  }

  // ── Step 2: Optional enrichment (never stops early — all leads are saved) ───
  await logger.log(`Starting enrichment [website:${!!enrichments.website}, email:${!!enrichments.email}] for ${results.length} leads...`);

  const processedLeads = [];
  let totalCreditsSpent = 0;
  let metrics = { emailsFound: 0, patternPredicted: 0, hunterUsed: 0, enrichSkipped: 0, scrapeSkipped: 0 };

  const platformBaseCost = PLATFORM_SCRAPE_COST[source] || PLATFORM_SCRAPE_COST[source === "instagram" ? "instagram_biz" : source] || 3;

  for (const lead of results) {
    let costForLead = 0;

    // Platform scrape cost (YouTube=5, Instagram=4, etc.)
    try {
      await deductUserCredits(userId, platformBaseCost, orgId);
      costForLead += platformBaseCost;
      await logCreditTransaction(
        userId,
        orgId,
        -platformBaseCost,
        `${source} scrape: ${lead.name || lead.company}`,
        source === "youtube" ? "youtube_scrape" : source === "instagram" || source === "instagram_biz" ? "instagram_scrape" : "scrape",
        lead.name
      );
    } catch (e) {
      metrics.scrapeSkipped++;
      await logger.log(`[SKIP] ${source} scrape credits (${platformBaseCost}) — no balance for ${lead.name}`);
      continue;
    }

    // Website enrichment — 2 credits when enabled (discoverCosts.ts)
    if (lead.website && enrichments.website) {
      const websiteCost = ENRICHMENT_SCRAPE_COST.website;
      const charged = await tryDeductUserCredits(
        userId,
        websiteCost,
        orgId,
        `Website enrich: ${lead.name || lead.company}`,
        "website_enrichment"
      );
      if (charged) {
        costForLead += websiteCost;
        try {
          const enriched = await enrichWebsite(lead.website, jobId);
          if (!lead.email && enriched.email) { lead.email = enriched.email; metrics.emailsFound++; }
          lead.isHiring = enriched.isHiring || false;
          lead.linkedin = lead.linkedin || enriched.linkedin || null;
          lead.twitter  = enriched.twitter || null;
          lead.metaDescription = enriched.metaDescription || null;
        } catch (e) {
          metrics.enrichSkipped++;
          await logger.log(`[SKIP] Website enrich failed for ${lead.name} (lead still saved)`);
        }
      } else {
        metrics.enrichSkipped++;
        await logger.log(`[SKIP] Website enrich credits (${websiteCost}) — no balance for ${lead.name}`);
      }
    }

    // Email discovery — 3 credits base; +5 when Hunter.io lookup runs
    if ((!lead.email && enrichments.email) || (enrichments.phone && !lead.phone)) {
      const domain = lead.website
        ? (() => { try { return new URL(lead.website).hostname.replace("www.", ""); } catch { return null; } })()
        : null;

      const lookupName = lead.contactName || lead.name;
      let emailEnrichReady = !!lead.email || !enrichments.email;

      if (!lead.email && enrichments.email) {
        const emailCost = ENRICHMENT_SCRAPE_COST.email;
        const charged = await tryDeductUserCredits(
          userId,
          emailCost,
          orgId,
          `Email enrich: ${lead.name || lead.company}`,
          "email_enrichment"
        );
        if (charged) {
          costForLead += emailCost;
          emailEnrichReady = true;
        } else {
          metrics.enrichSkipped++;
          await logger.log(`[SKIP] Email enrich credits (${emailCost}) — no balance for ${lead.name}`);
        }
      }

      if (emailEnrichReady || (enrichments.phone && !lead.phone)) {
        try {
          let hunterData = null;
          const hasHunterKey = !!process.env.HUNTER_API_KEY;

          if (hasHunterKey && domain) {
            const hunterCharged = await tryDeductUserCredits(
              userId,
              HUNTER_LOOKUP_COST,
              orgId,
              `Hunter.io lookup: ${lead.name || lead.company}`,
              "hunter_lookup"
            );

            if (hunterCharged) {
              costForLead += HUNTER_LOOKUP_COST;
              hunterData = await getEmailFromHunter(lookupName, domain, jobId);
            } else {
              await logger.log(`[SKIP] Hunter credits (${HUNTER_LOOKUP_COST}) — pattern fallback for ${lead.name}`);
            }
          }

          if (hunterData) {
            lead.email        = hunterData.email        || lead.email;
            lead.phone        = hunterData.phone        || lead.phone;
            lead.linkedin     = hunterData.linkedin     || lead.linkedin;
            lead.contactName  = hunterData.contactName  || lead.contactName;
            lead.contactTitle = hunterData.contactTitle || lead.contactTitle;
            if (hunterData.email) { metrics.hunterUsed++; metrics.emailsFound++; }
          } else if (!lead.email && enrichments.email && emailEnrichReady) {
            lead.email = predictEmail(lead.name, lead.website);
            if (lead.email) metrics.patternPredicted++;
          }
        } catch (e) {
          if (!lead.email && enrichments.email && emailEnrichReady) {
            try {
              lead.email = predictEmail(lead.name, lead.website);
              if (lead.email) {
                metrics.patternPredicted++;
                await logger.log(`[FALLBACK] Pattern engine used for ${lead.name}`);
              }
            } catch {
              metrics.enrichSkipped++;
              await logger.log(`[SKIP] Email discovery skipped for ${lead.name} (lead still saved)`);
            }
          } else {
            metrics.enrichSkipped++;
          }
        }
      }
    }

    lead.score = calcScore(lead);
    await logger.log(`✓ ${lead.name} — email: ${lead.email || "none"}, score: ${lead.score}`);
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
  await logger.log(`Saving ${processedLeads.length} leads...`);

  if (processedLeads.length > 0) {
    try {
      await saveToDatabaseLeads(processedLeads, userId, orgId || inputData.orgId, source);
    } catch (error) {
      await logger.log(`[ERROR] DB save failed: ${error.message}`);
      throw error;
    }
  }

  await logger.log(`✅ Job complete — ${processedLeads.length}/${results.length} leads saved (${metrics.scrapeSkipped} skipped: no scrape credits, ${metrics.enrichSkipped} enrich skipped)`);
  await logger.close();
  return {
    count: processedLeads.length,
    searched: results.length,
    leads: processedLeads,
    metrics,
  };
}

