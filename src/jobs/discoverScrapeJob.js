/**
 * CompX — discoverScrapeJob.js
 * Firecrawl + Google Maps API + Apollo email enrichment
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
  const fake = /example\.|test\.|noreply\.|placeholder\.|@sentry\.|@2x\./i;
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

// ── Apollo Email Lookup ───────────────────────────────────────────────────────
async function getEmailFromApollo(companyName, domain, jobId) {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return null;

  try {
    await logToTerminal(jobId, `Apollo lookup: ${companyName}`);

    // Domain থেকে email খোঁজো
    if (domain) {
      const res = await fetch("https://api.apollo.io/v1/organizations/enrich", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": apiKey,
        },
        body: JSON.stringify({ domain }),
      });

      const json = await res.json();
      const org = json?.organization;

      if (org?.sanitized_phone) {
        return { email: null, phone: org.sanitized_phone, linkedin: org.linkedin_url || null };
      }
    }

    // People search থেকে email খোঁজো
    const searchRes = await fetch("https://api.apollo.io/v1/mixed_people/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
      },
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
          email: person.email,
          phone: person.phone_numbers?.[0]?.sanitized_number || null,
          linkedin: person.linkedin_url || null,
          contactName: `${person.first_name} ${person.last_name}`.trim(),
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

// ── Google Maps API ───────────────────────────────────────────────────────────
async function searchGoogleMaps(keyword, location, maxResults = 10) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return [];

  const query = location ? `${keyword} in ${location}` : keyword;
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}`;

  const res  = await fetch(url);
  const json = await res.json();
  if (!json.results) return [];

  return json.results.slice(0, maxResults).map(place => ({
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

// ── Firecrawl Website Enrichment ──────────────────────────────────────────────
async function enrichWebsite(website, jobId) {
  try {
    const result  = await firecrawl.scrapeUrl(website, { formats: ["markdown"], timeout: 15000 });
    const content = result?.markdown || "";
    const emails  = extractEmails(content);
    const linkedin = content.match(/linkedin\.com\/company\/[\w-]+/)?.[0] || null;
    const twitter  = content.match(/twitter\.com\/[\w-]+/)?.[0] || null;

    return {
      email:    emails[0] || null,
      allEmails: emails,
      isHiring: detectHiring(content),
      linkedin: linkedin ? `https://${linkedin}` : null,
      twitter:  twitter  ? `https://${twitter}`  : null,
      metaDescription: result?.metadata?.description || null,
    };
  } catch {
    return {};
  }
}

// ── Main Job ──────────────────────────────────────────────────────────────────
export async function runDiscoverScrape(inputData, userId, jobId, proxy) {
  const { keyword, location, maxResults = 10 } = inputData;

  await logToTerminal(jobId, `Starting: "${keyword}" in "${location}"`);

  // Step 1: Google Maps
  await logToTerminal(jobId, `Searching Google Maps...`);
  const results = await searchGoogleMaps(keyword, location, maxResults);
  await logToTerminal(jobId, `Found ${results.length} businesses`);

  // Step 2: Place details (website + phone)
  for (const lead of results) {
    if (lead.placeId) {
      const details = await getPlaceDetails(lead.placeId);
      lead.website = details.website || null;
      lead.phone   = cleanPhone(details.phone) || null;
    }
  }

  // Step 3: Website scrape + Apollo email
  await logToTerminal(jobId, `Starting enrichment...`);

  for (const lead of results) {
    // Firecrawl দিয়ে website scrape
    if (lead.website) {
      const enriched = await enrichWebsite(lead.website, jobId);
      lead.email       = enriched.email    || null;
      lead.isHiring    = enriched.isHiring || false;
      lead.linkedin    = enriched.linkedin || null;
      lead.twitter     = enriched.twitter  || null;
      lead.metaDescription = enriched.metaDescription || null;
    }

    // Email না পেলে Apollo দিয়ে খোঁজো
    if (!lead.email) {
      const domain = lead.website
        ? new URL(lead.website).hostname.replace("www.", "")
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

  // Step 4: Database save
  await logToTerminal(jobId, `Saving ${results.length} leads...`);

  const leadsToInsert = results.map(lead => ({
    org_id:       inputData.orgId,
    source:       "google maps discover",
    company:      lead.name,
    name:         lead.name,
    phone:        lead.phone        || null,
    email:        lead.email        || null,
    website:      lead.website      || null,
    industry:     lead.industry     || null,
    score:        lead.score,
    lead_score:   lead.score,
    address:      lead.address      || null,
    is_hiring:    lead.isHiring     || false,
    linkedin:     lead.linkedin     || null,
    meta_description: lead.metaDescription || null,
    contact_name: lead.contactName  || null,
    contact_title: lead.contactTitle || null,
    created_at:   new Date().toISOString(),
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
