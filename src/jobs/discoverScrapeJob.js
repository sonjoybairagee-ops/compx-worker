/**
 * CompX — discoverScrapeJob.js
 * Platform Source routing: Google Maps | LinkedIn | Websites | Startup DB
 * Enrichment: Website (Firecrawl multi-page) | Email (Apollo) | Pattern fallback
 */

import FirecrawlApp from "@mendable/firecrawl-js";
import { supabase } from "../config/supabase.js";

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

const SERPAPI_KEY = () => process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY;

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

  // Fallback: SerpAPI google_maps engine
  await logToTerminal(jobId, `Falling back to SerpAPI (google_maps)...`);
  const sKey = SERPAPI_KEY();
  if (!sKey) return [];

  const query = location ? `${keyword} in ${location}` : keyword;
  const url = `https://serpapi.com/search.json?engine=google_maps&q=${encodeURIComponent(query)}&api_key=${sKey}&num=${maxResults}`;
  const res  = await fetch(url);
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
async function searchLinkedIn(keyword, location, maxResults, jobId) {
  const sKey = SERPAPI_KEY();
  if (!sKey) { await logToTerminal(jobId, `No SerpAPI key for LinkedIn search`); return []; }

  await logToTerminal(jobId, `Searching LinkedIn via SerpAPI...`);

  // Google-এ site:linkedin.com/company দিয়ে search
  const query = location
    ? `${keyword} ${location} site:linkedin.com/company`
    : `${keyword} site:linkedin.com/company`;

  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&api_key=${sKey}&num=${maxResults}`;
  const res  = await fetch(url);
  const json = await res.json();

  if (json.error) { await logToTerminal(jobId, `SerpAPI LinkedIn error: ${json.error}`); return []; }

  const organicResults = json.organic_results || [];
  await logToTerminal(jobId, `LinkedIn search: ${organicResults.length} results`);

  return organicResults.slice(0, maxResults).map(r => {
    // LinkedIn URL থেকে company name বের করো
    const linkedinMatch = r.link?.match(/linkedin\.com\/company\/([\w-]+)/);
    const companySlug   = linkedinMatch?.[1] || "";
    const companyName   = r.title?.replace(/ \| LinkedIn$/, "").replace(/ - LinkedIn$/, "").trim() || companySlug;

    return {
      id:       `li_${companySlug || Math.random()}`,
      name:     companyName,
      address:  location || "",
      rating:   "",
      industry: keyword,
      website:  null,
      phone:    null,
      email:    null,
      linkedin: r.link || null,
      snippet:  r.snippet || "",
      source:   "linkedin",
    };
  }).filter(r => r.name);
}

// ── 3. Websites Source ───────────────────────────────────────────────────────
async function searchWebsites(keyword, location, maxResults, jobId) {
  const sKey = SERPAPI_KEY();
  if (!sKey) { await logToTerminal(jobId, `No SerpAPI key for website search`); return []; }

  await logToTerminal(jobId, `Searching websites via SerpAPI (Google)...`);

  const query = location ? `${keyword} ${location}` : keyword;
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&api_key=${sKey}&num=${maxResults}`;
  const res  = await fetch(url);
  const json = await res.json();

  if (json.error) { await logToTerminal(jobId, `SerpAPI error: ${json.error}`); return []; }

  const results = json.organic_results || [];
  await logToTerminal(jobId, `Websites search: ${results.length} results`);

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
  const sKey = SERPAPI_KEY();
  if (!sKey) return [];

  await logToTerminal(jobId, `Searching Startup DB via SerpAPI...`);

  // Crunchbase + AngelList দিয়ে search
  const query = location
    ? `${keyword} ${location} site:crunchbase.com OR site:angel.co`
    : `${keyword} startup site:crunchbase.com OR site:angel.co`;

  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&api_key=${sKey}&num=${maxResults}`;
  const res  = await fetch(url);
  const json = await res.json();

  if (json.error) return [];

  const results = json.organic_results || [];
  await logToTerminal(jobId, `Startup DB: ${results.length} results`);

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

    const base  = website.replace(/\/$/, "").replace(/^http:\/\//, "https://");
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
    source      = "google_maps",   // google_maps | linkedin | websites | startup_db
    enrichments = {},              // { email: bool, website: bool, techStack: bool, aiScoring: bool }
  } = inputData;

  await logToTerminal(jobId, `Starting: "${keyword}" in "${location}" [source: ${source}]`);

  // ── Step 1: Platform Source routing ─────────────────────────────────────────
  let results = [];

  if (source === "linkedin") {
    results = await searchLinkedIn(keyword, location, maxResults, jobId);
  } else if (source === "websites") {
    results = await searchWebsites(keyword, location, maxResults, jobId);
  } else if (source === "startup_db") {
    results = await searchStartupDB(keyword, location, maxResults, jobId);
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

    // Email Discovery (Apollo → Pattern fallback)
    if (!lead.email && enrichments.email) {
      const domain = lead.website
        ? (() => { try { return new URL(lead.website).hostname.replace("www.", ""); } catch { return null; } })()
        : null;

      try {
        await deductUserCredits(userId, 3);
        costForLead += 3;
        const apolloData = await getEmailFromApollo(lead.name, domain, jobId);
        if (apolloData) {
          lead.email        = apolloData.email        || lead.email;
          lead.phone        = apolloData.phone        || lead.phone;
          lead.linkedin     = apolloData.linkedin     || lead.linkedin;
          lead.contactName  = apolloData.contactName  || null;
          lead.contactTitle = apolloData.contactTitle || null;
          metrics.apolloUsed++;
          metrics.emailsFound++;
        } else {
          // Apollo found nothing → pattern prediction (free)
          lead.email = predictEmail(lead.name, lead.website);
          if (lead.email) metrics.patternPredicted++;
        }
      } catch (e) {
        // Low credits → pattern prediction (1 credit)
        try {
          await deductUserCredits(userId, 1);
          costForLead += 1;
          lead.email = predictEmail(lead.name, lead.website);
          if (lead.email) metrics.patternPredicted++;
          await logToTerminal(jobId, `[LOW CREDITS] Pattern engine used for ${lead.name}`);
        } catch { await logToTerminal(jobId, `[SKIP] Email discovery skipped for ${lead.name}`); }
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

  const leadsToInsert = processedLeads.map(lead => ({
    org_id:           inputData.orgId,
    source:           source,
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

  await logToTerminal(jobId, `✅ Job complete — ${processedLeads.length} leads saved`);
  return { count: processedLeads.length, leads: processedLeads };
}
