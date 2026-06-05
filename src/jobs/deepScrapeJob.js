/**
 * CompX Worker — src/jobs/deepScrapeJob.js
 * Puppeteer সরিয়ে Firecrawl + Google Maps API দিয়ে replace করা হয়েছে
 * Render Free/Paid সব tier-এ কাজ করবে
 */

import FirecrawlApp from "@mendable/firecrawl-js";
import { supabase } from "../config/supabase.js";

// ── Firecrawl client ──────────────────────────────────────────────────────────
const firecrawl = new FirecrawlApp({
  apiKey: process.env.FIRECRAWL_API_KEY,
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function extractEmails(text = "") {
  const matches = text.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi);
  const fakePatterns = /example\.|test\.|noreply\.|placeholder\./i;
  return matches ? [...new Set(matches)].filter(e => !fakePatterns.test(e)) : [];
}

function extractPhones(text = "") {
  const matches = text.match(/(\+?[\d\s\-().]{7,20})/g);
  return matches ? [...new Set(matches.map(p => p.trim()))].slice(0, 3) : [];
}

function detectHiring(text = "") {
  const lower = text.toLowerCase();
  return ["we're hiring", "we are hiring", "join our team", "open positions",
    "careers", "job openings", "greenhouse.io", "lever.co", "workable.com"]
    .some(kw => lower.includes(kw));
}

function calcScore(lead) {
  let score = 30;
  if (lead.website)  score += 15;
  if (lead.phone)    score += 15;
  if (lead.email)    score += 25;
  if (lead.rating && parseFloat(lead.rating) >= 4.0) score += 10;
  if (lead.isHiring) score += 20;
  if (lead.linkedin) score += 10;
  return Math.min(99, score);
}

// ── Google Maps Places API ────────────────────────────────────────────────────
async function searchGoogleMaps(keyword, location, maxResults = 20) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.warn("[DeepScrape] No GOOGLE_MAPS_API_KEY");
    return [];
  }

  const query = location ? `${keyword} in ${location}` : keyword;
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}`;

  const res  = await fetch(url);
  const json = await res.json();
  if (!json.results) return [];

  return json.results.slice(0, maxResults).map(place => ({
    company_name: place.name,
    address:      place.formatted_address,
    rating:       place.rating?.toString() || "",
    category:     place.types?.[0]?.replace(/_/g, " ") || "",
    website:      null,
    phone:        null,
    placeId:      place.place_id,
  }));
}

async function getPlaceDetails(placeId) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey || !placeId) return {};
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=website,formatted_phone_number&key=${apiKey}`;
  const res  = await fetch(url);
  const json = await res.json();
  return {
    website: json.result?.website || null,
    phone:   json.result?.formatted_phone_number || null,
  };
}

// ── Firecrawl Search (for non-Maps sources) ───────────────────────────────────
async function searchWithFirecrawl(query, maxResults = 20) {
  try {
    const results = await firecrawl.search(query, { limit: maxResults });
    return (results?.data || []).map(r => ({
      company_name: r.title || "",
      website:      r.url   || "",
      description:  r.description || "",
    })).filter(r => r.company_name);
  } catch (err) {
    console.error("[DeepScrape] Firecrawl search error:", err.message);
    return [];
  }
}

// ── Website Enrichment ────────────────────────────────────────────────────────
async function enrichWebsite(website) {
  if (!website) return {};
  try {
    const result  = await firecrawl.scrapeUrl(website, { formats: ["markdown"], timeout: 15000 });
    const content = result?.markdown || "";
    const emails  = extractEmails(content);
    const phones  = extractPhones(content);
    const linkedin = content.match(/linkedin\.com\/company\/[\w-]+/)?.[0] || null;
    const twitter  = content.match(/twitter\.com\/[\w-]+/)?.[0] || null;
    return {
      email:    emails[0] || null,
      phone:    phones[0] || null,
      isHiring: detectHiring(content),
      linkedin: linkedin ? `https://${linkedin}` : null,
      twitter:  twitter  ? `https://${twitter}`  : null,
      metaDescription: result?.metadata?.description || null,
    };
  } catch {
    return {};
  }
}

// ── Source Handlers ───────────────────────────────────────────────────────────
async function handleGoogleMaps(inputData) {
  const { keyword, location, maxResults = 20 } = inputData;
  console.log(`[DeepScrape] Google Maps: "${keyword}" in "${location}"`);

  const results = await searchGoogleMaps(keyword, location, maxResults);

  // Place details (website + phone)
  for (const lead of results) {
    if (lead.placeId) {
      const details = await getPlaceDetails(lead.placeId);
      lead.website = details.website || null;
      lead.phone   = lead.phone || details.phone || null;
    }
  }

  // Website enrichment
  for (const lead of results) {
    const enriched = await enrichWebsite(lead.website);
    Object.assign(lead, enriched);
    lead.score = calcScore(lead);
  }

  return results;
}

async function handleLinkedIn(inputData) {
  const { keyword, location } = inputData;
  const query = `site:linkedin.com/company ${keyword} ${location || ""}`;
  console.log(`[DeepScrape] LinkedIn search: "${query}"`);
  const results = await searchWithFirecrawl(query, 20);
  for (const r of results) {
    r.linkedin_url = r.website;
    r.score = 50;
  }
  return results;
}

async function handleYellowPages(inputData) {
  const { keyword, location } = inputData;
  const url = `https://www.yellowpages.com/search?search_terms=${encodeURIComponent(keyword)}&geo_location_terms=${encodeURIComponent(location || "")}`;
  console.log(`[DeepScrape] YellowPages: ${url}`);
  try {
    const result  = await firecrawl.scrapeUrl(url, { formats: ["markdown"] });
    const content = result?.markdown || "";
    const emails  = extractEmails(content);
    return emails.map(email => ({ company_name: keyword, email, score: 50 }));
  } catch {
    return [];
  }
}

async function handleGenericSearch(inputData, platform) {
  const { keyword, location } = inputData;
  const query = `${keyword} ${location || ""} ${platform}`;
  console.log(`[DeepScrape] Generic search for ${platform}: "${query}"`);
  const results = await searchWithFirecrawl(query, 20);
  for (const r of results) r.score = 40;
  return results;
}

// ── Main Entry ────────────────────────────────────────────────────────────────
export async function runDeepScrape(inputData, userId) {
  const source = (inputData?.source || "google_maps").toLowerCase().replace(/-/g, "_");
  console.log(`[DeepScrape] ▶ source="${source}" user=${userId}`);

  let results = [];

  switch (source) {
    case "google_maps":
    case "google_maps_scrape":
    case "discover_scrape":
    case "scrape":
      results = await handleGoogleMaps(inputData);
      break;

    case "linkedin":
    case "linkedin_scrape":
      results = await handleLinkedIn(inputData);
      break;

    case "yellow_pages":
    case "yellow_pages_scrape":
      results = await handleYellowPages(inputData);
      break;

    case "yelp":
    case "clutch":
    case "g2":
    case "facebook_biz":
    case "amazon_seller":
    case "instagram_biz":
      results = await handleGenericSearch(inputData, source);
      break;

    default:
      console.warn(`[DeepScrape] No handler for source: "${source}"`);
  }

  console.log(`[DeepScrape] ✅ Done — ${results.length} results`);

  // ── Save to Supabase ──────────────────────────────────────────────────────
  if (results.length > 0 && userId) {
    const rows = results
      .filter(r => r.company_name)
      .map(r => ({
        user_id:      userId,
        source,
        company_name: r.company_name || "Unknown",
        phone:        r.phone        || null,
        address:      r.address      || null,
        website:      r.website      || null,
        category:     r.category     || null,
        rating:       r.rating ? parseFloat(r.rating) : null,
        linkedin_url: r.linkedin_url || null,
        email:        r.email        || null,
        is_hiring:    r.isHiring     || false,
        score:        r.score        || 40,
        scraped_at:   Date.now(),
        created_at:   new Date().toISOString(),
      }));

    if (rows.length > 0) {
      const { error } = await supabase
        .from("extension_database")
        .upsert(rows, { onConflict: "hash", ignoreDuplicates: true });

      if (error) console.error("[DeepScrape] Supabase error:", error.message);
      else       console.log(`[DeepScrape] Stored ${rows.length} leads`);
    }
  }

  return { count: results.length, results, source };
}
