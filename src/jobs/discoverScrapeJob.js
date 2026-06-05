/**
 * CompX — discoverScrapeJob.js
 * Playwright সরিয়ে Firecrawl + Google Maps API দিয়ে replace করা হয়েছে
 * Render Free/Paid সব tier-এ কাজ করবে
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

// Email extract from text
function extractEmails(text = "") {
  const matches = text.match(
    /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi
  );
  const fakePatterns = /example\.|test\.|noreply\.|placeholder\./i;
  return matches
    ? [...new Set(matches)].filter((e) => !fakePatterns.test(e))
    : [];
}

// Phone extract and clean
function cleanPhone(phone) {
  return phone?.replace(/[^\d+]/g, '').replace(/^880/, '+880') || null;
}

function extractPhones(text = "") {
  const matches = text.match(
    /(\+?[\d\s\-().]{7,20})/g
  );
  return matches ? [...new Set(matches.map((p) => p.trim()))].slice(0, 3) : [];
}

// Score calculation
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

// Hiring signals
const HIRING_KEYWORDS = [
  "we're hiring", "we are hiring", "join our team",
  "open positions", "careers", "job openings",
  "greenhouse.io", "lever.co", "workable.com", "jobs.ashbyhq.com",
];

function detectHiring(text = "") {
  const lower = text.toLowerCase();
  return HIRING_KEYWORDS.some((kw) => lower.includes(kw));
}

// ── Google Maps Search via Places API ────────────────────────────────────────
async function searchGoogleMaps(keyword, location) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    console.warn("[DiscoverScrape] No GOOGLE_MAPS_API_KEY — using mock data");
    return [];
  }

  const query = `${keyword} in ${location}`;
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}`;

  const res = await fetch(url);
  const json = await res.json();

  if (!json.results) return [];

  return json.results.slice(0, 10).map((place) => ({
    id:       `map_${place.place_id}`,
    name:     place.name,
    address:  place.formatted_address,
    rating:   place.rating?.toString() || "",
    industry: place.types?.[0]?.replace(/_/g, " ") || "",
    website:  null, // Places API detail call-এ পাওয়া যাবে
    phone:    null,
    email:    null,
    score:    40,
    hiring:   false,
    placeId:  place.place_id,
  }));
}

// ── Get website from Place Details ───────────────────────────────────────────
async function getPlaceDetails(placeId) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey || !placeId) return {};

  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=website,formatted_phone_number&key=${apiKey}`;

  const res = await fetch(url);
  const json = await res.json();

  return {
    website: json.result?.website || null,
    phone:   json.result?.formatted_phone_number || null,
  };
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

    const emails  = extractEmails(content);
    const phones  = extractPhones(content);
    const isHiring = detectHiring(content);

    // Social links
    const linkedin = content.match(/linkedin\.com\/company\/[\w-]+/)?.[0] || null;
    const twitter  = content.match(/twitter\.com\/[\w-]+/)?.[0] || null;

    return {
      email:    emails[0] || null,
      allEmails: emails,
      phone:    phones[0] || null,
      isHiring,
      linkedin: linkedin ? `https://${linkedin}` : null,
      twitter:  twitter  ? `https://${twitter}`  : null,
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
  await logToTerminal(jobId, `Using Firecrawl (no browser needed)`);

  // ── Step 1: Google Maps থেকে businesses খোঁজো ──────────────────────────
  await logToTerminal(jobId, `Searching Google Maps...`);
  let results = await searchGoogleMaps(keyword, location);
  await logToTerminal(jobId, `Found ${results.length} businesses`);

  // ── Step 2: প্রতিটা business-এর website + phone বের করো ────────────────
  await logToTerminal(jobId, `Fetching place details...`);
  for (const lead of results) {
    if (lead.placeId) {
      const details = await getPlaceDetails(lead.placeId);
      lead.website = details.website || null;
      lead.phone   = lead.phone || details.phone || null;
    }
  }

  // ── Step 3: Website থেকে email + signals বের করো ───────────────────────
  await logToTerminal(jobId, `Starting website enrichment phase...`);

  for (const lead of results) {
    if (lead.website) {
      const enriched = await enrichWebsite(lead.website, jobId);
      lead.email       = enriched.email       || lead.email;
      lead.phone       = enriched.phone       || lead.phone;
      lead.isHiring    = enriched.isHiring    || false;
      lead.linkedin    = enriched.linkedin    || null;
      lead.twitter     = enriched.twitter     || null;
      lead.allEmails   = enriched.allEmails   || [];
      lead.metaDescription = enriched.metaDescription || null;

      await logToTerminal(
        jobId,
        `✓ ${lead.name} — email: ${lead.email || "none"}, hiring: ${lead.isHiring}`
      );
    }

    // Score calculate করো
    lead.score = calcScore(lead);
  }

  // ── Step 4: Database-এ save করো ─────────────────────────────────────────
  await logToTerminal(jobId, `Saving ${results.length} leads to database...`);

  const leadsToInsert = results.map((lead) => ({
    org_id:    inputData.orgId,
    source:    "google maps discover",
    company:   lead.name,
    name:      lead.name,
    phone:     cleanPhone(lead.phone),
    email:     lead.email   || null,
    website:   lead.website || null,
    industry:  lead.industry || null,
    score:     lead.score,
    lead_score: lead.score,
    address:   lead.address || null,
    is_hiring: lead.isHiring || false,
    linkedin:  lead.linkedin || null,
    meta_description: lead.metaDescription || null,
    created_at: new Date().toISOString(),
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
