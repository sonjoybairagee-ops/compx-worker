/**
 * CompX — discoverScrapeJob.js
 * Platform Source routing: Google Maps | LinkedIn | Websites | Startup DB | YouTube | Instagram
 *
 * CHANGES (startup-optimized):
 *   1. Apollo সম্পূর্ণ বাদ — Hunter.io দিয়ে replace ($0.001/lookup vs $0.05)
 *   2. Firecrawl বাদ — নিজের Cheerio scraper দিয়ে replace ($0 cost)
 *   3. Email chain: Cheerio scrape → Google search → Hunter.io → Pattern prediction
 *   4. Tech Stack enrichment block যোগ (আগে credit কাটত কিন্তু কাজ হত না)
 *   5. AI Intent Scoring block যোগ (আগে credit কাটত কিন্তু কাজ হত না)
 *   6. APOLLO_LOOKUP_COST সরানো
 */

import * as cheerio from "cheerio";
import { supabase } from "../config/supabase.js";
import { createLogger } from "../lib/terminalLogger.js";
import { saveToDatabaseLeads } from "./pipelineSave.js";

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
const PLATFORM_SCRAPE_COST = {
  google_maps:  3,
  linkedin:     5,
  youtube:      5,
  instagram:    4,
  instagram_biz:4,
  websites:     3,
  startup_db:   5,
};

const ENRICHMENT_SCRAPE_COST = {
  website: 2,
  email:   3,
  tech:    1,
  ai:      1,
};

// APOLLO_LOOKUP_COST সরানো হয়েছে ✂️

async function deductUserCredits(userId, amount, orgId) {
  const { error } = await supabase.rpc("deduct_credits", {
    p_user_id: userId,
    p_org_id:  orgId || userId,
    p_amount:  amount,
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

async function logCreditTransaction(userId, orgId, amount, reason, type) {
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
    { email: `info@${domain}`,    score: 0.2 },
    { email: `contact@${domain}`, score: 0.2 },
    { email: `${f}@${domain}`,    score: 0.3 },
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
    "careers", "job openings", "greenhouse.io", "lever.co", "workable.com",
  ].some(kw => lower.includes(kw));
}

// ── Tech Stack Detection (enrichments.tech এ ব্যবহার হবে) ──────────────────
function detectTechStack(html = "") {
  const checks = [
    ["WordPress",        () => html.includes("/wp-content/")],
    ["Shopify",          () => html.includes("cdn.shopify.com")],
    ["Webflow",          () => html.includes("webflow.io")],
    ["Squarespace",      () => html.includes("squarespace.com")],
    ["Wix",              () => html.includes("wix.com")],
    ["HubSpot",          () => html.includes("hs-scripts.com") || html.includes("hubspot.com")],
    ["Intercom",         () => html.includes("widget.intercom.io")],
    ["Zendesk",          () => html.includes("zendesk.com")],
    ["Stripe",           () => html.includes("js.stripe.com")],
    ["Next.js",          () => html.includes("__NEXT_DATA__")],
    ["Google Analytics", () => html.includes("google-analytics.com") || html.includes("gtag")],
    ["Salesforce",       () => html.includes("salesforce.com")],
  ];
  return checks
    .filter(([, fn]) => { try { return fn(); } catch { return false; } })
    .map(([n]) => n);
}

// ── AI Intent Score (enrichments.ai এ ব্যবহার হবে) ──────────────────────────
function calcAIIntentScore(lead) {
  let score = 30; // base

  // Contact info signals
  if (lead.email)   score += 25;
  if (lead.phone)   score += 15;
  if (lead.website) score += 10;
  if (lead.linkedin)score += 10;

  // Business quality signals
  if (lead.rating && parseFloat(lead.rating) >= 4.0) score += 10;
  if (lead.isHiring) score += 15;

  // Tech stack signals (modern stack = higher intent)
  if (lead.techStack?.length > 0) {
    if (lead.techStack.includes("HubSpot"))   score += 5; // already using sales tools
    if (lead.techStack.includes("Stripe"))    score += 5; // paying customers
    if (lead.techStack.includes("Intercom"))  score += 5; // customer-focused
  }

  // Platform-specific signals
  if (lead.source === "youtube") {
    const subs = parseInt(lead.subscriberCount || "0");
    if (subs >= 100000) score += 15;
    else if (subs >= 10000) score += 10;
    else if (subs >= 1000)  score += 5;
  }

  if (lead.source === "instagram" || lead.source === "instagram_biz") {
    const followers = parseInt(lead.followersCount || "0");
    if (followers >= 100000) score += 15;
    else if (followers >= 10000) score += 10;
    else if (followers >= 1000)  score += 5;
    if (lead.isBusinessAccount) score += 10;
    if (lead.isVerified)        score += 5;
  }

  return Math.min(99, score);
}

function calcScore(lead) {
  // aiScore already calculated হলে সেটা ব্যবহার করো
  if (lead.aiScore) return Math.min(99, lead.aiScore);

  let score = 30;
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
  const blocked = ["facebook.com","instagram.com","twitter.com","linkedin.com","youtube.com","tiktok.com"];
  return !blocked.some(b => url.includes(b));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const SERPER_KEY  = () => process.env.SERPER_API_KEY;
const SERPAPI_KEY = () => process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY;

// ── Serper.dev helper ─────────────────────────────────────────────────────────
async function serperSearch(type, query, num = 10, page = 1) {
  const key = SERPER_KEY();
  if (!key) return null;
  const endpoints = {
    google:      "https://google.serper.dev/search",
    google_maps: "https://google.serper.dev/maps",
    images:      "https://google.serper.dev/images",
    news:        "https://google.serper.dev/news",
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
    if (places.length < need) break;
  }
  return all.slice(0, maxResults);
}

// ════════════════════════════════════════════════════════════════════════════
// ENRICHMENT FUNCTIONS (Firecrawl replace — নিজের Cheerio scraper)
// ════════════════════════════════════════════════════════════════════════════

// ── Cheerio single page scrape ($0 cost, Firecrawl replace) ──────────────────
async function scrapeSinglePageCherio(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { text: "", html: "" };
    const html = await res.text();
    const $ = cheerio.load(html);
    $("script, style, noscript").remove();
    return { text: $("body").text().replace(/\s+/g, " ").trim(), html };
  } catch {
    return { text: "", html: "" };
  }
}

// ── Cheerio multi-page enrichment (Firecrawl replace) ────────────────────────
async function enrichWebsite(website, jobId) {
  try {
    if (!isScrapable(website)) {
      await logToTerminal(jobId, `⏭ Skipping social URL: ${website}`);
      return {};
    }

    const hasProto = /^https?:\/\//.test(website);
    const base = hasProto ? website.replace(/\/$/, "") : `https://${website.replace(/\/$/, "")}`;

    // Smart page order — homepage আগে, email পেলে বাকি বাদ (credit বাঁচায়)
    const pages = [base, `${base}/contact`, `${base}/contact-us`, `${base}/about`, `${base}/about-us`];

    let allText = "";
    let allHtml = "";

    for (const pageUrl of pages) {
      await logToTerminal(jobId, `Scraping ${pageUrl}...`);
      const { text, html } = await scrapeSinglePageCherio(pageUrl);
      allText += " " + text;
      allHtml += " " + html;

      const found = extractEmails(text);
      if (found.length > 0) {
        await logToTerminal(jobId, `✉ Email found on ${pageUrl}`);
        break; // email পেলেই থামো — বাকি page scrape করা দরকার নেই
      }
    }

    const emails   = extractEmails(allText);
    const linkedin = allHtml.match(/linkedin\.com\/(?:company|in)\/[\w-]+/)?.[0] || null;
    const twitter  = allHtml.match(/(?:twitter|x)\.com\/[\w-]+/)?.[0] || null;
    const techStack = detectTechStack(allHtml);

    return {
      email:    emails[0] || null,
      isHiring: detectHiring(allText),
      linkedin: linkedin ? `https://${linkedin}` : null,
      twitter:  twitter  ? `https://${twitter}`  : null,
      techStack,
      metaDescription: null,
    };
  } catch (err) {
    await logToTerminal(jobId, `Enrichment failed: ${err.message}`);
    return {};
  }
}

// ── Hunter.io email lookup (Apollo replace) ───────────────────────────────────
// Cost: flat plan ~$0.001/lookup (Apollo ছিল $0.05/lookup — 50x সস্তা)
async function getEmailFromHunter(domain, jobId) {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) return null;

  try {
    await logToTerminal(jobId, `Hunter.io lookup: ${domain}`);
    const res = await fetch(
      `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${apiKey}&limit=3`,
      { signal: AbortSignal.timeout(8000) }
    );
    const json = await res.json();
    if (json.errors?.length) return null;

    const emails = json.data?.emails || [];
    // confidence > 70 এমন email খোঁজো, না পেলে যা আছে নাও
    const best = emails.find(e => e.confidence >= 70) || emails[0];
    if (!best?.value) return null;

    await logToTerminal(jobId, `Hunter found: ${best.value} (confidence: ${best.confidence}%)`);
    return {
      email:        best.value,
      contactName:  [best.first_name, best.last_name].filter(Boolean).join(" ") || null,
      contactTitle: best.position || null,
      linkedin:     best.linkedin || null,
      phone:        null, // Hunter basic plan এ phone নেই
    };
  } catch (err) {
    await logToTerminal(jobId, `Hunter.io error: ${err.message}`);
    return null;
  }
}

// ── Google Search email fallback (Serper.dev ব্যবহার করে — $0 extra cost) ───
async function findEmailViaGoogle(companyName, domain, jobId) {
  if (!domain || !companyName) return null;
  try {
    const query = `"${companyName}" email "@${domain}"`;
    const data  = await serperSearch("google", query, 3);
    if (!data?.organic) return null;

    const allText = data.organic.map(r => r.snippet || "").join(" ");
    const emails  = extractEmails(allText).filter(e => e.includes(domain));
    if (emails[0]) {
      await logToTerminal(jobId, `Google search email found: ${emails[0]}`);
    }
    return emails[0] || null;
  } catch {
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PLATFORM SOURCE FUNCTIONS (পরিবর্তন নেই)
// ════════════════════════════════════════════════════════════════════════════

// ── 1. Google Maps Source ────────────────────────────────────────────────────
async function searchGoogleMaps(keyword, location, maxResults, jobId) {
  const query = location ? `${keyword} in ${location}` : keyword;

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
            const dRes  = await fetch(dUrl);
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

  // Fallback: SerpAPI
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
  const parts   = cleaned.split(/\s*[|\-–—@]\s*/);
  const fullName = parts[0]?.trim() || cleaned;
  const rest     = parts.slice(1).join(" - ").trim();
  let contactTitle = rest;
  let company = null;
  const atMatch = rest.match(/^(.+?)\s+at\s+(.+)$/i);
  if (atMatch) { contactTitle = atMatch[1].trim(); company = atMatch[2].trim(); }
  return { fullName, contactTitle, company };
}

function buildLinkedInQuery(keyword, location, linkedinFilters = {}) {
  const titles = [...(linkedinFilters.jobTitles || []), ...(linkedinFilters.targetAudiences || [])].slice(0, 10);
  const companyTypes = (linkedinFilters.companyTypes || []).slice(0, 4);
  const employeeHint = (linkedinFilters.employeeSizes || []).join(" ");
  const legalHint    = (linkedinFilters.companyLegalTypes || []).slice(0, 2).join(" ");

  if (titles.length > 0) {
    const titlePart   = titles.map(t => `"${t}"`).join(" OR ");
    const companyPart = companyTypes.length ? `(${companyTypes.join(" OR ")})` : "";
    const metaPart    = [employeeHint, legalHint].filter(Boolean).join(" ");
    return `(${titlePart}) ${companyPart} ${metaPart} site:linkedin.com/in ${location}`.replace(/\s+/g, " ").trim();
  }
  return location
    ? `${keyword} ${location} site:linkedin.com/in OR site:linkedin.com/company`
    : `${keyword} site:linkedin.com/in OR site:linkedin.com/company`;
}

async function searchLinkedIn(keyword, location, maxResults, jobId, linkedinFilters = {}) {
  const query = buildLinkedInQuery(keyword, location, linkedinFilters);
  await logToTerminal(jobId, `LinkedIn query: ${query}`);

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
            name: company || fullName, contactName: fullName,
            contactTitle: contactTitle || keyword,
            address: location || "", rating: "", industry: contactTitle || keyword,
            website: null, phone: null, email: null,
            linkedin: r.link || null, snippet: r.snippet || "",
            source: "linkedin", linkedinFilters,
          };
        }
        const linkedinMatch = r.link?.match(/linkedin\.com\/company\/([\w-]+)/);
        const companySlug   = linkedinMatch?.[1] || "";
        const companyName   = r.title?.replace(/ \| LinkedIn$/, "").replace(/ - LinkedIn$/, "").trim() || companySlug;
        return {
          id: `li_${companySlug || Math.random()}`, name: companyName,
          address: location || "", rating: "", industry: keyword,
          website: null, phone: null, email: null,
          linkedin: r.link || null, snippet: r.snippet || "",
          source: "linkedin", linkedinFilters,
        };
      }).filter(r => r.name || r.contactName);
    }
  }

  // Fallback: SerpAPI
  const sKey = SERPAPI_KEY();
  if (!sKey) { await logToTerminal(jobId, `No SerpAPI key for LinkedIn search`); return []; }
  const url  = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&api_key=${sKey}&num=${maxResults}`;
  const res  = await fetch(url);
  const json = await res.json();
  if (json.error) return [];
  return (json.organic_results || []).slice(0, maxResults).map(r => {
    const isProfile = r.link?.includes("linkedin.com/in/");
    if (isProfile) {
      const { fullName, contactTitle, company } = parseLinkedInProfileTitle(r.title || "");
      return {
        id: `li_${Math.random().toString(36).slice(2, 9)}`,
        name: company || fullName, contactName: fullName,
        contactTitle: contactTitle || keyword,
        address: location || "", industry: contactTitle || keyword,
        website: null, phone: null, email: null,
        linkedin: r.link || null, snippet: r.snippet || "",
        source: "linkedin", linkedinFilters,
      };
    }
    const linkedinMatch = r.link?.match(/linkedin\.com\/company\/([\w-]+)/);
    const companySlug   = linkedinMatch?.[1] || "";
    const companyName   = r.title?.replace(/ \| LinkedIn$/, "").replace(/ - LinkedIn$/, "").trim() || companySlug;
    return {
      id: `li_${companySlug || Math.random()}`, name: companyName,
      address: location || "", industry: keyword,
      website: null, phone: null, email: null,
      linkedin: r.link || null, snippet: r.snippet || "",
      source: "linkedin", linkedinFilters,
    };
  }).filter(r => r.name || r.contactName);
}

// ── 3. Websites Source ───────────────────────────────────────────────────────
async function searchWebsites(keyword, location, maxResults, jobId) {
  const query = location ? `${keyword} ${location}` : keyword;

  const serperData = await serperSearch("google", query, maxResults);
  if (serperData?.organic?.length) {
    await logToTerminal(jobId, `Serper.dev websites: ${serperData.organic.length} results ✅`);
    return serperData.organic.slice(0, maxResults).map(r => ({
      id: `web_${Math.random()}`, name: r.title?.trim() || r.displayedLink || "",
      address: location || "", rating: "", industry: keyword,
      website: r.link || null, phone: null, email: null, linkedin: null,
      snippet: r.snippet || "", source: "websites",
    })).filter(r => r.name && r.website);
  }

  const sKey = SERPAPI_KEY();
  if (!sKey) return [];
  const url  = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&api_key=${sKey}&num=${maxResults}`;
  const res  = await fetch(url);
  const json = await res.json();
  if (json.error) return [];
  return (json.organic_results || []).slice(0, maxResults).map(r => ({
    id: `web_${Math.random()}`, name: r.title?.trim() || r.displayed_link || "",
    address: location || "", rating: "", industry: keyword,
    website: r.link || null, phone: null, email: null, linkedin: null,
    snippet: r.snippet || "", source: "websites",
  })).filter(r => r.name && r.website);
}

// ── 4. Startup DB Source ─────────────────────────────────────────────────────
async function searchStartupDB(keyword, location, maxResults, jobId) {
  const query = location
    ? `${keyword} ${location} site:crunchbase.com OR site:angel.co`
    : `${keyword} startup site:crunchbase.com OR site:angel.co`;

  const serperData = await serperSearch("google", query, maxResults);
  if (serperData?.organic?.length) {
    await logToTerminal(jobId, `Serper.dev Startup DB: ${serperData.organic.length} results ✅`);
    return serperData.organic.slice(0, maxResults).map(r => ({
      id: `startup_${Math.random()}`,
      name: r.title?.replace(/ - Crunchbase.*/, "").replace(/ \| AngelList.*/, "").trim() || "",
      address: location || "", rating: "", industry: keyword,
      website: null, phone: null, email: null, linkedin: null,
      crunchbase: r.link?.includes("crunchbase.com") ? r.link : null,
      snippet: r.snippet || "", source: "startup_db",
    })).filter(r => r.name);
  }

  const sKey = SERPAPI_KEY();
  if (!sKey) return [];
  const url  = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&api_key=${sKey}&num=${maxResults}`;
  const res  = await fetch(url);
  const json = await res.json();
  if (json.error) return [];
  return (json.organic_results || []).slice(0, maxResults).map(r => ({
    id: `startup_${Math.random()}`,
    name: r.title?.replace(/ - Crunchbase.*/, "").replace(/ \| AngelList.*/, "").trim() || "",
    address: location || "", rating: "", industry: keyword,
    website: null, phone: null, email: null, linkedin: null,
    crunchbase: r.link?.includes("crunchbase.com") ? r.link : null,
    snippet: r.snippet || "", source: "startup_db",
  })).filter(r => r.name);
}

// ── 5. YouTube Source ────────────────────────────────────────────────────────
async function searchYouTube(keyword, location, maxResults, jobId, enrichments = {}) {
  // About page scraping proxy ছাড়া disable — YouTube block করে
  enrichments = { ...enrichments, email: false };

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) { await logToTerminal(jobId, `[ERROR] YOUTUBE_API_KEY not set`); return []; }

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
  if (!items.length) { await logToTerminal(jobId, `YouTube: no channels found`); return []; }
  await logToTerminal(jobId, `YouTube: ${items.length} channels found ✅`);

  const channelIds = items.map(i => i.snippet.channelId).join(",");
  const detailUrl  = new URL("https://www.googleapis.com/youtube/v3/channels");
  detailUrl.searchParams.set("part", "snippet,statistics");
  detailUrl.searchParams.set("id", channelIds);
  detailUrl.searchParams.set("key", apiKey);

  const detailRes  = await fetch(detailUrl.toString());
  const detailJson = await detailRes.json();
  if (detailJson.error) { await logToTerminal(jobId, `YouTube details error: ${detailJson.error.message}`); return []; }

  const channels = detailJson.items || [];
  return channels.map(ch => ({
    id:              `yt_${ch.id}`,
    name:            ch.snippet?.title || "",
    company:         ch.snippet?.title || "",
    industry:        keyword,
    address:         location || ch.snippet?.country || "",
    rating:          "",
    website:         null, phone: null, email: null, linkedin: null,
    source:          "youtube",
    channelId:       ch.id,
    channelUrl:      `https://www.youtube.com/channel/${ch.id}`,
    subscriberCount: ch.statistics?.subscriberCount || "0",
    videoCount:      ch.statistics?.videoCount      || "0",
    viewCount:       ch.statistics?.viewCount       || "0",
    joinedDate:      ch.snippet?.publishedAt        || null,
    description:     ch.snippet?.description        || "",
    country:         ch.snippet?.country            || null,
  }));
}

// ── 6. Instagram Source (Apify) ───────────────────────────────────────────────
async function runApifyActor(actorId, input, apifyToken, jobId, timeoutMs = 120000) {
  const runRes = await fetch(
    `https://api.apify.com/v2/acts/${actorId}/runs?token=${apifyToken}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }
  );
  const runJson = await runRes.json();
  if (!runJson?.data?.id) {
    await logToTerminal(jobId, `[Apify] Failed to start ${actorId}`);
    return null;
  }

  const runId     = runJson.data.id;
  const datasetId = runJson.data.defaultDatasetId;
  await logToTerminal(jobId, `[Apify] ${actorId} run started: ${runId}`);

  const pollInterval = 5000;
  const maxAttempts  = Math.ceil(timeoutMs / pollInterval);
  let status = "RUNNING";

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, pollInterval));
    const statusRes  = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${apifyToken}`);
    const statusJson = await statusRes.json();
    status = statusJson?.data?.status || "FAILED";
    await logToTerminal(jobId, `[Apify] ${actorId} status: ${status} (${(i + 1) * 5}s)`);
    if (status === "SUCCEEDED") break;
    if (["FAILED","ABORTED","TIMED-OUT"].includes(status)) return null;
  }

  if (status !== "SUCCEEDED") return null;

  const dataRes  = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}&clean=true`);
  const dataJson = await dataRes.json();
  return Array.isArray(dataJson) ? dataJson : (dataJson?.items || []);
}

async function searchInstagram(keyword, location, maxResults, jobId) {
  const apifyToken = process.env.APIFY_API_TOKEN;
  if (!apifyToken) { await logToTerminal(jobId, `[ERROR] APIFY_API_TOKEN not set`); return []; }

  try {
    const hashtag = keyword.split(/[\s/,#]+/).filter(Boolean)[0]?.toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (!hashtag) return [];

    await logToTerminal(jobId, `[Instagram] Step A — Hashtag scraper: #${hashtag}`);
    const hashtagItems = await runApifyActor(
      "apify~instagram-hashtag-scraper",
      { hashtags: [hashtag], resultsLimit: Math.min(maxResults * 5, 100) },
      apifyToken, jobId, 90000
    );
    if (!hashtagItems?.length) return [];

    const usernameMap = new Map();
    for (const post of hashtagItems) {
      const owner = post.ownerUsername || post.owner?.username;
      if (owner && !usernameMap.has(owner)) usernameMap.set(owner, post);
    }
    const usernames = [...usernameMap.keys()].slice(0, maxResults);
    if (!usernames.length) return [];

    await logToTerminal(jobId, `[Instagram] Step B — Profile scraper for ${usernames.length} accounts`);
    const profileItems = await runApifyActor(
      "apify~instagram-profile-scraper",
      { usernames },
      apifyToken, jobId, 120000
    );
    if (!profileItems?.length) return [];

    return profileItems.filter(p => p.username).slice(0, maxResults).map(p => ({
      id: `ig_${p.id || p.username}`,
      name: p.fullName || p.username || "",
      company: p.fullName || p.username || "",
      industry: keyword,
      address: p.businessAddressJson
        ? [p.businessAddressJson.street_address, p.businessAddressJson.city_name, p.businessAddressJson.country_code].filter(Boolean).join(", ")
        : location || "",
      rating: "", website: p.externalUrl || null,
      phone: p.businessPhoneNumber || null, email: p.businessEmail || null,
      linkedin: null, source: "instagram",
      username: p.username || null, handle: `@${p.username}` || null,
      profileUrl: `https://www.instagram.com/${p.username}/`,
      followersCount: p.followersCount || 0, followsCount: p.followsCount || 0,
      postsCount: p.postsCount || 0, bio: p.biography || null,
      isVerified: p.verified || false, isBusinessAccount: p.isBusinessAccount || false,
      accountType: p.businessCategoryName || null, igLocation: p.businessAddressJson || null,
    }));
  } catch (err) {
    await logToTerminal(jobId, `[Instagram] Error: ${err.message}`);
    return [];
  }
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN JOB
// ════════════════════════════════════════════════════════════════════════════
export async function runDiscoverScrape(inputData, userId, job, proxy) {
  const jobId  = job.id;
  const logger = createLogger(jobId);
  const {
    keyword,
    location,
    maxResults      = 10,
    source          = "google_maps",
    enrichments     = {},
    linkedinFilters = null,
    orgId           = null,
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
    results = await searchYouTube(keyword, location, maxResults, jobId, enrichments);
  } else if (source === "instagram" || source === "instagram_biz") {
    results = await searchInstagram(keyword, location, maxResults, jobId);
  } else {
    results = await searchGoogleMaps(keyword, location, maxResults, jobId);
  }

  await logger.log(`Found ${results.length} results from [${source}]`);

  if (results.length === 0) {
    await logger.log(`No results found`);
    await logger.close();
    return { count: 0, leads: [] };
  }

  // ── Step 2: Enrichment ───────────────────────────────────────────────────────
  await logger.log(`Starting enrichment [website:${!!enrichments.website}, email:${!!enrichments.email}, tech:${!!enrichments.tech}, ai:${!!enrichments.ai}] for ${results.length} leads...`);

  const processedLeads  = [];
  let totalCreditsSpent = 0;
  let metrics = {
    emailsFound:      0,
    patternPredicted: 0,
    hunterUsed:       0,  // apolloUsed → hunterUsed
    googleEmailFound: 0,
    techDetected:     0,
    aiScored:         0,
    enrichSkipped:    0,
    scrapeSkipped:    0,
  };

  const platformBaseCost = PLATFORM_SCRAPE_COST[source] || 3;

  for (const lead of results) {
    let costForLead = 0;

    // ── Platform scrape cost ────────────────────────────────────────────────
    try {
      await deductUserCredits(userId, platformBaseCost, orgId);
      costForLead += platformBaseCost;
      await logCreditTransaction(
        userId, orgId, -platformBaseCost,
        `${source} scrape: ${lead.name || lead.company}`,
        source === "youtube" ? "youtube_scrape" :
        (source === "instagram" || source === "instagram_biz") ? "instagram_scrape" : "scrape"
      );
    } catch (e) {
      metrics.scrapeSkipped++;
      await logger.log(`[SKIP] ${source} scrape credits (${platformBaseCost}) — no balance for ${lead.name}`);
      continue;
    }

    // ── Website Enrichment (+2 credits) ────────────────────────────────────
    // Cheerio দিয়ে করে — Firecrawl এর দরকার নেই
    if (lead.website && enrichments.website) {
      const charged = await tryDeductUserCredits(
        userId, ENRICHMENT_SCRAPE_COST.website, orgId,
        `Website enrich: ${lead.name || lead.company}`, "website_enrichment"
      );
      if (charged) {
        costForLead += ENRICHMENT_SCRAPE_COST.website;
        try {
          const enriched = await enrichWebsite(lead.website, jobId);
          if (!lead.email && enriched.email) { lead.email = enriched.email; metrics.emailsFound++; }
          lead.isHiring  = enriched.isHiring  || false;
          lead.linkedin  = lead.linkedin || enriched.linkedin || null;
          lead.twitter   = enriched.twitter   || null;
          lead.techStack = enriched.techStack  || [];
        } catch (e) {
          metrics.enrichSkipped++;
          await logger.log(`[SKIP] Website enrich failed for ${lead.name} (lead still saved)`);
        }
      } else {
        metrics.enrichSkipped++;
        await logger.log(`[SKIP] Website enrich credits — no balance for ${lead.name}`);
      }
    }

    // ── Email Discovery (+3 credits) ────────────────────────────────────────
    // Chain: Cheerio (already done above) → Google Search → Hunter.io → Pattern
    // Apollo সম্পূর্ণ বাদ ✂️
    if (!lead.email && enrichments.email) {
      const domain = lead.website
        ? (() => { try { return new URL(lead.website).hostname.replace("www.", ""); } catch { return null; } })()
        : null;

      const charged = await tryDeductUserCredits(
        userId, ENRICHMENT_SCRAPE_COST.email, orgId,
        `Email enrich: ${lead.name || lead.company}`, "email_enrichment"
      );

      if (charged) {
        costForLead += ENRICHMENT_SCRAPE_COST.email;

        try {
          // Step 1: Google Search দিয়ে email খোঁজো (Serper.dev — already paid)
          if (!lead.email && domain) {
            const googleEmail = await findEmailViaGoogle(lead.name, domain, jobId);
            if (googleEmail) {
              lead.email = googleEmail;
              metrics.googleEmailFound++;
              metrics.emailsFound++;
            }
          }

          // Step 2: Hunter.io domain search (Apollo replace — 50x সস্তা)
          if (!lead.email && domain) {
            const hunterData = await getEmailFromHunter(domain, jobId);
            if (hunterData?.email) {
              lead.email        = hunterData.email;
              lead.contactName  = lead.contactName  || hunterData.contactName;
              lead.contactTitle = lead.contactTitle || hunterData.contactTitle;
              lead.linkedin     = lead.linkedin     || hunterData.linkedin;
              metrics.hunterUsed++;
              metrics.emailsFound++;
            }
          }

          // Step 3: Pattern prediction fallback ($0 cost)
          if (!lead.email) {
            lead.email = predictEmail(lead.name, lead.website);
            if (lead.email) {
              metrics.patternPredicted++;
              await logger.log(`[PATTERN] Predicted email for ${lead.name}: ${lead.email}`);
            }
          }
        } catch (e) {
          // Last resort: pattern prediction
          lead.email = predictEmail(lead.name, lead.website);
          if (lead.email) {
            metrics.patternPredicted++;
            await logger.log(`[FALLBACK] Pattern engine used for ${lead.name}`);
          } else {
            metrics.enrichSkipped++;
          }
        }
      } else {
        metrics.enrichSkipped++;
        await logger.log(`[SKIP] Email enrich credits — no balance for ${lead.name}`);
      }
    }

    // ── Tech Stack Analysis (+1 credit) ────────────────────────────────────
    // আগে: credit কাটত কিন্তু কিছু হত না ❌
    // এখন: detectTechStack() call করে ✅
    if (enrichments.tech && lead.website) {
      const charged = await tryDeductUserCredits(
        userId, ENRICHMENT_SCRAPE_COST.tech, orgId,
        `Tech stack: ${lead.name || lead.company}`, "tech_enrichment"
      );
      if (charged) {
        costForLead += ENRICHMENT_SCRAPE_COST.tech;
        try {
          // Website enrichment এ ইতিমধ্যে techStack পেলে reuse করো
          if (!lead.techStack?.length) {
            const { html } = await scrapeSinglePageCherio(lead.website);
            lead.techStack = detectTechStack(html);
          }
          if (lead.techStack?.length) {
            metrics.techDetected++;
            await logger.log(`🔧 Tech stack for ${lead.name}: ${lead.techStack.join(", ")}`);
          }
        } catch (e) {
          await logger.log(`[SKIP] Tech stack detection failed for ${lead.name}`);
        }
      }
    }

    // ── AI Intent Scoring (+1 credit) ──────────────────────────────────────
    // আগে: credit কাটত কিন্তু কিছু হত না ❌
    // এখন: calcAIIntentScore() call করে ✅
    if (enrichments.ai) {
      const charged = await tryDeductUserCredits(
        userId, ENRICHMENT_SCRAPE_COST.ai, orgId,
        `AI scoring: ${lead.name || lead.company}`, "ai_enrichment"
      );
      if (charged) {
        costForLead += ENRICHMENT_SCRAPE_COST.ai;
        lead.aiScore = calcAIIntentScore(lead);
        metrics.aiScored++;
        await logger.log(`🤖 AI score for ${lead.name}: ${lead.aiScore}`);
      }
    }

    // Final score
    lead.score = calcScore(lead);
    await logger.log(`✓ ${lead.name} — email: ${lead.email || "none"}, score: ${lead.score}${lead.techStack?.length ? `, tech: ${lead.techStack.join(",")}` : ""}`);

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
          avgCost:      parseFloat((totalCreditsSpent / processedLeads.length).toFixed(2)),
        },
        processedCount: processedLeads.length,
        totalCount:     results.length,
      });
    } catch {}
  }

  // ── Step 3: DB save ──────────────────────────────────────────────────────────
  await logger.log(`Saving ${processedLeads.length} leads...`);

  if (processedLeads.length > 0) {
    try {
      await saveToDatabaseLeads(processedLeads, userId, orgId || inputData.orgId, source);
    } catch (error) {
      await logger.log(`[ERROR] DB save failed: ${error.message}`);
      throw error;
    }
  }

  await logger.log(
    `✅ Job complete — ${processedLeads.length}/${results.length} leads saved` +
    ` | emails: ${metrics.emailsFound} (hunter: ${metrics.hunterUsed}, google: ${metrics.googleEmailFound}, pattern: ${metrics.patternPredicted})` +
    ` | tech: ${metrics.techDetected} | ai: ${metrics.aiScored}` +
    ` | skipped: scrape=${metrics.scrapeSkipped} enrich=${metrics.enrichSkipped}`
  );
  await logger.close();

  return {
    count:   processedLeads.length,
    searched: results.length,
    leads:   processedLeads,
    metrics,
  };
}