/**
 * CompX — discoverScrapeJob.js
 * Google Maps API (primary) + SerpAPI (fallback) + Firecrawl multi-page + Apollo
 */

import FirecrawlApp from "@mendable/firecrawl-js";
import { supabase } from "../config/supabase.js";

const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

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

// ── Helpers ───────────────────────────────────────────────────────────────────
function extractEmails(text = "") {
  const matches = text.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi);
  const fake = /example\.|test\.|noreply\.|placeholder\.|@sentry\.|@2x\.|\.png|\.jpg|\.gif|\.svg/i;
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
  if (lead.website)  score += 15;
  if (lead.phone)    score += 15;
  if (lead.email)    score += 25;
  if (lead.rating && parseFloat(lead.rating) >= 4.0) score += 10;
  if (lead.isHiring) score += 20;
  if (lead.linkedin) score += 10;
  return Math.min(99, score);
}

// Social media URL হলে scrape skip করো
function isScrapable(url = "") {
  const blocked = ["facebook.com", "instagram.com", "twitter.com", "linkedin.com", "youtube.com", "tiktok.com"];
  return !blocked.some(b => url.includes(b));
}

// ── Google Maps API (Primary) ─────────────────────────────────────────────────
async function searchWithGoogleMaps(keyword, location, maxResults = 10) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;

  try {
    const query = location ? `${keyword} in ${location}` : keyword;
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}`;
    const res  = await fetch(url);
    const json = await res.json();

    if (json.status === "REQUEST_DENIED" || json.status === "OVER_QUERY_LIMIT") {
      console.warn(`[DiscoverScrape] Google Maps: ${json.status} — switching to SerpAPI`);
      return null;
    }

    if (!json.results || json.results.length === 0) return null;

    const results = json.results.slice(0, maxResults).map(place => ({
      id:       `map_${place.place_id}`,
      name:     place.name,
      address:  place.formatted_address,
      rating:   place.rating?.toString() || "",
      industry: place.types?.[0]?.replace(/_/g, " ") || "",
      website:  null,
      phone:    null,
      email:    null,
      placeId:  place.place_id,
    }));

    for (const lead of results) {
      if (lead.placeId) {
        const detailUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${lead.placeId}&fields=website,formatted_phone_number&key=${apiKey}`;
        const detailRes  = await fetch(detailUrl);
        const detailJson = await detailRes.json();
        lead.website = detailJson.result?.website || null;
        lead.phone   = detailJson.result?.formatted_phone_number || null;
      }
    }

    return results;
  } catch (err) {
    console.error("[DiscoverScrape] Google Maps error:", err.message);
    return null;
  }
}

// ── SerpAPI (Fallback) ────────────────────────────────────────────────────────
async function searchWithSerpAPI(keyword, location, maxResults = 10) {
  // SERPAPI_KEY বা SERPAPI_API_KEY দুটোই check করো
  const apiKey = process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY;
  if (!apiKey) return [];

  try {
    const query = location ? `${keyword} in ${location}` : keyword;
    const url = `https://serpapi.com/search.json?engine=google_maps&q=${encodeURIComponent(query)}&api_key=${apiKey}&num=${maxResults}`;
    const res  = await fetch(url);
    const json = await res.json();

    if (json.error) {
      console.error("[DiscoverScrape] SerpAPI error:", json.error);
      return [];
    }

    const places = json.local_results || [];
    return places.slice(0, maxResults).map(place => ({
      id:       `serp_${place.place_id || Math.random()}`,
      name:     place.title   || "",
      address:  place.address || "",
      rating:   place.rating?.toString() || "",
      industry: place.type    || keyword || "",
      website:  place.website || null,
      phone:    place.phone   || null,
      email:    null,
      placeId:  null,
    })).filter(r => r.name);
  } catch (err) {
    console.error("[DiscoverScrape] SerpAPI error:", err.message);
    return [];
  }
}

// ── Smart Search ──────────────────────────────────────────────────────────────
async function searchBusinesses(keyword, location, maxResults, jobId) {
  await logToTerminal(jobId, `Trying Google Maps API...`);
  const googleResults = await searchWithGoogleMaps(keyword, location, maxResults);

  if (googleResults && googleResults.length > 0) {
    await logToTerminal(jobId, `Google Maps: ${googleResults.length} results ✅`);
    return googleResults;
  }

  await logToTerminal(jobId, `Google Maps failed — switching to SerpAPI...`);
  const serpResults = await searchWithSerpAPI(keyword, location, maxResults);
  await logToTerminal(jobId, `SerpAPI: ${serpResults.length} results`);
  return serpResults;
}

// ── Apollo Email Lookup ───────────────────────────────────────────────────────
async function getEmailFromApollo(companyName, domain, jobId) {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return null;

  try {
    await logToTerminal(jobId, `Apollo lookup: ${companyName}`);
    const searchRes = await fetch("https://api.apollo.io/v1/mixed_people/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
      body: JSON.stringify({
        organization_name: companyName,
        person_titles: ["owner", "founder", "ceo", "director", "manager"],
        per_page: 3,
      }),
    });

    const searchJson = await searchRes.json();
    const people = searchJson?.people || [];

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

// ── Firecrawl Single Page Scrape ──────────────────────────────────────────────
async function scrapeSinglePage(url) {
  try {
    const result = await firecrawl.scrapeUrl(url, { formats: ["markdown"], timeout: 12000 });
    return result?.markdown || "";
  } catch {
    return "";
  }
}

// ── Firecrawl Multi-page Enrichment ──────────────────────────────────────────
// Homepage → /contact → /contact-us → /about → /about-us → stop যখন email পাবে
async function enrichWebsite(website, jobId) {
  try {
    if (!isScrapable(website)) {
      await logToTerminal(jobId, `⏭ Skipping social URL: ${website}`);
      return {};
    }

    const base = website.replace(/\/$/, "").replace(/^http:\/\//, "https://");

    const pages = [
      base,
      `${base}/contact`,
      `${base}/contact-us`,
      `${base}/about`,
      `${base}/about-us`,
      `${base}/reach-us`,
    ];

    let allContent = "";
    const linkedin_re = /linkedin\.com\/(?:company|in)\/[\w-]+/;
    const twitter_re  = /twitter\.com\/[\w-]+/;

    for (const pageUrl of pages) {
      await logToTerminal(jobId, `Scraping ${pageUrl}...`);
      const content = await scrapeSinglePage(pageUrl);
      allContent += " " + content;

      const emails = extractEmails(content);
      if (emails.length > 0) {
        await logToTerminal(jobId, `✉ Email found: ${emails[0]}`);
        break; // পেয়ে গেছি, আর scrape করতে হবে না
      }
    }

    const emails   = extractEmails(allContent);
    const linkedin = allContent.match(linkedin_re)?.[0] || null;
    const twitter  = allContent.match(twitter_re)?.[0] || null;

    return {
      email:    emails[0] || null,
      isHiring: detectHiring(allContent),
      linkedin: linkedin ? `https://${linkedin}` : null,
      twitter:  twitter  ? `https://${twitter}`  : null,
      metaDescription: null,
    };
  } catch (err) {
    await logToTerminal(jobId, `Enrichment failed for ${website}: ${err.message}`);
    return {};
  }
}

// ── Main Job ──────────────────────────────────────────────────────────────────
export async function runDiscoverScrape(inputData, userId, jobId, proxy) {
  const { keyword, location, maxResults = 10 } = inputData;

  await logToTerminal(jobId, `Starting: "${keyword}" in "${location}"`);

  // Step 1: Search
  const results = await searchBusinesses(keyword, location, maxResults, jobId);
  if (results.length === 0) {
    await logToTerminal(jobId, `No results found`);
    return { count: 0, leads: [] };
  }

  // Step 2: Multi-page enrichment + Apollo fallback
  await logToTerminal(jobId, `Starting enrichment for ${results.length} businesses...`);

  for (const lead of results) {
    // Firecrawl — multi-page
    if (lead.website) {
      const enriched = await enrichWebsite(lead.website, jobId);
      lead.email    = enriched.email    || null;
      lead.isHiring = enriched.isHiring || false;
      lead.linkedin = enriched.linkedin || lead.linkedin || null;
      lead.twitter  = enriched.twitter  || null;
      lead.metaDescription = enriched.metaDescription || null;
    }

    // Email এখনো নেই → Apollo try করো
    if (!lead.email) {
      const domain = lead.website
        ? (() => { try { return new URL(lead.website).hostname.replace("www.", ""); } catch { return null; } })()
        : null;

      const apolloData = await getEmailFromApollo(lead.name, domain, jobId);
      if (apolloData) {
        lead.email        = apolloData.email        || lead.email;
        lead.phone        = apolloData.phone        || lead.phone;
        lead.linkedin     = apolloData.linkedin     || lead.linkedin;
        lead.contactName  = apolloData.contactName  || null;
        lead.contactTitle = apolloData.contactTitle || null;
      }
    }

    lead.score = calcScore(lead);
    await logToTerminal(jobId, `✓ ${lead.name} — email: ${lead.email || "none"}, score: ${lead.score}`);
  }

  // Step 3: DB save
  await logToTerminal(jobId, `Saving ${results.length} leads...`);

  const leadsToInsert = results.map(lead => ({
    org_id:           inputData.orgId,
    source:           "google maps discover",
    company:          lead.name,
    name:             lead.name,
    phone:            cleanPhone(lead.phone),
    email:            lead.email            || null,
    website:          lead.website          || null,
    industry:         lead.industry         || null,
    score:            lead.score,
    lead_score:       lead.score,
    address:          lead.address          || null,
    is_hiring:        lead.isHiring         || false,
    linkedin:         lead.linkedin         || null,
    meta_description: lead.metaDescription  || null,
    contact_name:     lead.contactName      || null,
    contact_title:    lead.contactTitle     || null,
    created_at:       new Date().toISOString(),
  }));

  if (leadsToInsert.length > 0) {
    const { error } = await supabase.from("leads").insert(leadsToInsert);
    if (error) {
      await logToTerminal(jobId, `[ERROR] DB save failed: ${error.message}`);
      throw error;
    }
  }

  await logToTerminal(jobId, `✅ Job complete — ${results.length} leads saved`);
  return { count: results.length, leads: results };
}
