/**
 * CompX — discoverScrapeJob.js
 * SerpAPI (Google Maps) + Firecrawl দিয়ে lead discovery
 * কোনো Google Cloud billing লাগবে না ✅
 */

import FirecrawlApp from "@mendable/firecrawl-js";
import { supabase } from "../config/supabase.js";

// ── Firecrawl client ──────────────────────────────────────────────────────────
const firecrawl = new FirecrawlApp({
  apiKey: process.env.FIRECRAWL_API_KEY,
});

// ── Helpers ───────────────────────────────────────────────────────────────────
async function logToTerminal(jobId, message) {
  console.log(`[DiscoverScrape ${jobId}] ${message}`);
  try {
    const { data } = await supabase
      .from("jobs")
      .select("terminal_logs")
      .eq("id", jobId)
      .single();
    const logs = data?.terminal_logs || [];
    logs.push({ time: new Date().toISOString(), message });
    await supabase
      .from("jobs")
      .update({ terminal_logs: logs })
      .eq("id", jobId);
  } catch (e) {}
}

function extractEmails(text = "") {
  const matches = text.match(
    /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi
  );
  const fakePatterns = /example\.|test\.|noreply\.|placeholder\./i;
  return matches
    ? [...new Set(matches)].filter((e) => !fakePatterns.test(e))
    : [];
}

function extractPhones(text = "") {
  const matches = text.match(/(\+?[\d\s\-().]{7,20})/g);
  return matches ? [...new Set(matches.map((p) => p.trim()))].slice(0, 3) : [];
}

function calcScore(lead) {
  let score = 30;
  if (lead.website) score += 15;
  if (lead.phone)   score += 15;
  if (lead.email)   score += 25;
  if (lead.rating && parseFloat(lead.rating) >= 4.0) score += 10;
  if (lead.isHiring) score += 20;
  if (lead.linkedin) score += 10;
  return Math.min(99, score);
}

const HIRING_KEYWORDS = [
  "we're hiring", "we are hiring", "join our team",
  "open positions", "careers", "job openings",
  "greenhouse.io", "lever.co", "workable.com", "jobs.ashbyhq.com",
];

function detectHiring(text = "") {
  const lower = text.toLowerCase();
  return HIRING_KEYWORDS.some((kw) => lower.includes(kw));
}

// ── SerpAPI — Google Maps Search ─────────────────────────────────────────────
async function searchGoogleMaps(keyword, location) {
  const apiKey = process.env.SERPAPI_KEY;

  if (!apiKey) {
    console.warn("[DiscoverScrape] No SERPAPI_KEY found in environment");
    return [];
  }

  const query = `${keyword} in ${location}`;
  const url = `https://serpapi.com/search.json?engine=google_maps&q=${encodeURIComponent(query)}&api_key=${apiKey}&type=search`;

  try {
    const res = await fetch(url);
    const json = await res.json();

    if (json.error) {
      console.error("[DiscoverScrape] SerpAPI error:", json.error);
      return [];
    }

    const places = json.local_results || [];

    return places.slice(0, 10).map((place) => ({
      id:       `map_${place.place_id || place.data_id || Math.random()}`,
      name:     place.title || "Unknown",
      address:  place.address || "",
      rating:   place.rating?.toString() || "",
      reviews:  place.reviews?.toString() || "",
      industry: place.type || "",
      website:  place.website || null,
      phone:    place.phone || null,
      email:    null,
      score:    40,
      isHiring: false,
      linkedin: null,
    }));
  } catch (err) {
    console.error("[DiscoverScrape] SerpAPI fetch error:", err.message);
    return [];
  }
}

// ── Website Enrichment via Firecrawl ─────────────────────────────────────────
async function enrichWebsite(website, jobId) {
  try {
    await logToTerminal(jobId, `Scraping ${website}...`);

    const result = await firecrawl.scrapeUrl(website, {
      formats: ["markdown"],
      timeout: 15000,
    });

    const content = result?.markdown || "";

    const emails   = extractEmails(content);
    const phones   = extractPhones(content);
    const isHiring = detectHiring(content);

    const linkedin = content.match(/linkedin\.com\/company\/[\w-]+/)?.[0] || null;
    const twitter  = content.match(/twitter\.com\/[\w-]+/)?.[0] || null;

    return {
      email:          emails[0] || null,
      allEmails:      emails,
      phone:          phones[0] || null,
      isHiring,
      linkedin:       linkedin ? `https://${linkedin}` : null,
      twitter:        twitter  ? `https://${twitter}`  : null,
      metaDescription: result?.metadata?.description || null,
    };
  } catch (err) {
    await logToTerminal(jobId, `Enrichment failed for ${website}: ${err.message}`);
    return {};
  }
}

// ── Main Job ──────────────────────────────────────────────────────────────────
export async function runDiscoverScrape(inputData, userId, jobId, proxy) {
  const { keyword, location } = inputData;

  await logToTerminal(jobId, `Starting discovery: "${keyword}" in "${location}"`);
  await logToTerminal(jobId, `Using SerpAPI + Firecrawl (no browser needed)`);

  // ── Step 1: SerpAPI দিয়ে Google Maps থেকে businesses খোঁজো ─────────────
  await logToTerminal(jobId, `Searching Google Maps via SerpAPI...`);
  let results = await searchGoogleMaps(keyword, location);
  await logToTerminal(jobId, `Found ${results.length} businesses`);

  if (results.length === 0) {
    await logToTerminal(jobId, `⚠️ No results found. Check SERPAPI_KEY or try different keyword/location.`);
    await logToTerminal(jobId, `✅ Job complete — 0 leads saved`);
    return { count: 0, leads: [] };
  }

  // ── Step 2: Website থেকে email + signals বের করো ───────────────────────
  await logToTerminal(jobId, `Starting website enrichment phase...`);

  for (const lead of results) {
    if (lead.website) {
      const enriched = await enrichWebsite(lead.website, jobId);
      lead.email           = enriched.email       || lead.email;
      lead.phone           = enriched.phone       || lead.phone;
      lead.isHiring        = enriched.isHiring    || false;
      lead.linkedin        = enriched.linkedin    || null;
      lead.twitter         = enriched.twitter     || null;
      lead.allEmails       = enriched.allEmails   || [];
      lead.metaDescription = enriched.metaDescription || null;

      await logToTerminal(
        jobId,
        `✓ ${lead.name} — email: ${lead.email || "none"}, hiring: ${lead.isHiring}`
      );
    }

    lead.score = calcScore(lead);
  }

  // ── Step 3: Database-এ save করো ─────────────────────────────────────────
  await logToTerminal(jobId, `Saving ${results.length} leads to database...`);

  const leadsToInsert = results.map((lead) => ({
    org_id:           inputData.orgId,
    source:           "google maps discover",
    company:          lead.name,
    name:             lead.name,
    phone:            lead.phone    || null,
    email:            lead.email    || null,
    website:          lead.website  || null,
    industry:         lead.industry || null,
    score:            lead.score,
    lead_score:       lead.score,
    address:          lead.address  || null,
    is_hiring:        lead.isHiring || false,
    linkedin:         lead.linkedin || null,
    meta_description: lead.metaDescription || null,
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

  return {
    count: results.length,
    leads: results,
  };
}
