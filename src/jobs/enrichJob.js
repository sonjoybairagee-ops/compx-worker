/**
 * jobs/enrichJob.js
 *
 * Enhanced with safe domain filtering, single-pass Firecrawl logic,
 * and smart email pattern prediction guards.
 */

import {
  fetchPage,
  htmlToText,
  extractLinks,
  extractMetaDescription,
  extractEmailsFromText,
  predictEmailPatterns,
  isSocialDomain,
} from "@compx/scraper-core";

const TECH_SIGNATURES = [
  { name: "WordPress", pattern: /wp-content|wp-includes/i },
  { name: "Shopify", pattern: /cdn\.shopify\.com/i },
  { name: "Webflow", pattern: /webflow\.com/i },
  { name: "React", pattern: /__next|react-dom|_app-[a-f0-9]+\.js/i },
  { name: "HubSpot", pattern: /js\.hs-scripts\.com|hubspot/i },
  { name: "Squarespace", pattern: /squarespace\.com/i },
];

const EXCLUDED_WEBSITE_DOMAINS = [
  "youtube.com", "google.com", "maps.google.com", "wikipedia.org",
  "amazon.com", "yelp.com", "glassdoor.com", "indeed.com", "crunchbase.com",
  "bloomberg.com", "reddit.com", "quora.com", "pinterest.com",
];

function detectTechStack(html) {
  return TECH_SIGNATURES.filter((t) => t.pattern.test(html)).map((t) => t.name);
}

function extractSocialLinks(html, baseUrl) {
  const links = extractLinks(html, baseUrl);
  const social = {};
  for (const link of links) {
    if (link.includes("linkedin.com")) social.linkedin = social.linkedin || link;
    else if (link.includes("facebook.com")) social.facebook = social.facebook || link;
    else if (link.includes("twitter.com") || link.includes("x.com")) social.twitter = social.twitter || link;
    else if (link.includes("instagram.com")) social.instagram = social.instagram || link;
  }
  return social;
}

async function tryHunterIo(domain) {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(
      `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${apiKey}&limit=1`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.emails?.[0]?.value || null;
  } catch (err) {
    console.warn(`[EnrichJob] Hunter.io lookup failed for ${domain}:`, err.message);
    return null;
  }
}

async function findWebsiteViaSerper(companyName) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey || !companyName?.trim()) return null;

  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: companyName.trim(), num: 5 }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;

    const data = await res.json();
    for (const result of data?.organic || []) {
      if (!result?.link) continue;
      try {
        const hostname = new URL(result.link).hostname.replace(/^www\./, "");
        if (isSocialDomain(hostname)) continue;
        if (EXCLUDED_WEBSITE_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`))) continue;
        return hostname;
      } catch { continue; }
    }
    return null;
  } catch (err) {
    console.warn(`[EnrichJob] Serper lookup failed for "${companyName}":`, err.message);
    return null;
  }
}

async function tryFirecrawlScrape(url) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown", "html"] })
    });
    if (!res.ok) {
      console.warn(`[EnrichJob] Firecrawl API Error (${res.status}):`, await res.text());
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[EnrichJob] Firecrawl fallback failed for ${url}:`, err.message);
    return null;
  }
}

export async function runEnrichJob(input, userId) {
  const { website, name, domain, contact_name } = input;
  let target = website || domain;
  let discoveredWebsite = null;

  // Discover website via Serper if missing
  if (!target && name) {
    discoveredWebsite = await findWebsiteViaSerper(name);
    if (discoveredWebsite) target = discoveredWebsite;
  }

  if (!target) return { emails: [], phones: [], work_email: null };

  const url = /^https?:\/\//i.test(target) ? target : `https://${target}`;
  const hostname = new URL(url).hostname.replace(/^www\./, "");

  // Single-pass scraping strategy
  let html = "";
  let text = "";
  let firecrawlUsed = false;

  try {
    const page = await fetchPage(url);
    if (!page.ok) throw new Error(`HTTP ${page.status}`);
    html = page.html;
    text = htmlToText(html);
  } catch (err) {
    console.warn(`[EnrichJob] Static fetch failed for ${url}, attempting Firecrawl...`);
    const fcData = await tryFirecrawlScrape(url);
    if (fcData?.success && fcData.data) {
      html = fcData.data.html || "";
      text = fcData.data.markdown || htmlToText(html);
      firecrawlUsed = true;
    } else {
      return {
        emails: [], phones: [], work_email: null, 
        error: "Fetch and Firecrawl both failed",
        website: discoveredWebsite || undefined,
      };
    }
  }

  // Extract all data in one pass
  const rawEmails = extractEmailsFromText(text);
  // ✅ FIX: Safely filter social emails by extracting domain first
  const scrapedEmails = rawEmails.filter((e) => {
    const domainPart = e.split("@")[1];
    return domainPart && !isSocialDomain(domainPart);
  });

  const phoneMatch = text.match(/(\+?\d[\d\s().-]{7,}\d)/);
  const techStack = detectTechStack(html);
  const socialLinks = extractSocialLinks(html, url);
  const metaDescription = extractMetaDescription(html);

  let workEmail = scrapedEmails[0] || null;
  let hunterUsed = false;
  let patternPredicted = false;

  // Fallback 1: Hunter.io
  if (!workEmail) {
    const hunterEmail = await tryHunterIo(hostname);
    if (hunterEmail) {
      workEmail = hunterEmail;
      hunterUsed = true;
    }
  }

  // Fallback 2: Email Pattern Prediction
  // ✅ FIX: Only predict if we have a plausible person name (2+ words) or explicit contact_name
  const personName = contact_name || name;
  if (!workEmail && personName) {
    const parts = personName.trim().split(/\s+/);
    // Require at least 2 parts to avoid predicting "acme@corp.com" from company names
    if (parts.length >= 2) {
      const predicted = predictEmailPatterns({ first: parts[0], last: parts[1] }, hostname);
      if (predicted.length) {
        workEmail = predicted[0];
        patternPredicted = true;
      }
    }
  }

  return {
    emails: workEmail ? [...new Set([workEmail, ...scrapedEmails])] : scrapedEmails,
    phones: phoneMatch ? [phoneMatch[1].trim()] : [],
    work_email: workEmail,
    social_links: socialLinks,
    socials: socialLinks,
    techStack,
    metaDescription,
    hunterUsed,
    patternPredicted,
    firecrawlUsed,
    website: hostname,
  };
}