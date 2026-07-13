/**
 * jobs/enrichJob.js
 *
 * Given a website/domain, finds a contact email (scraped → Hunter.io if
 * configured → pattern-predicted as last resort), phone, tech stack hints,
 * and social links. Used both by the standalone "enrich" job type
 * (dispatcher.js::runEnrichPipeline) and by pipelineFilterJob.js when a
 * staging lead has a website but no email yet.
 *
 * UPDATED: leads that arrive with no website at all (e.g. YouTube channels,
 * where the platform hides business emails behind a captcha and often has
 * no linked site in the description) previously short-circuited here with
 * an empty result — no Hunter.io, no scraping, nothing. Now, when `name`
 * (company/channel name) is present but `website`/`domain` isn't, we first
 * ask Serper to find the company's likely official website, then run the
 * normal fetch → scrape → Hunter.io → pattern-predict pipeline against
 * whatever it finds. If Serper finds nothing (or isn't configured), we
 * still return the same empty result as before — this is a strict
 * additive fallback, not a behavior change for leads that already have
 * a website.
 *
 * Built on scraper-core instead of duplicating fetch/parsing logic that now
 * lives there.
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

// Domains that are never a company's "official website" even when they
// show up near the top of a name search — directories, platforms, and
// the source platforms themselves (no point "discovering" youtube.com
// as the website for a YouTube channel).
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
    const email = data?.data?.emails?.[0]?.value;
    return email || null;
  } catch (err) {
    console.warn(`[EnrichJob] Hunter.io lookup failed for ${domain}:`, err.message);
    return null;
  }
}

/**
 * Given just a company/channel name, ask Serper for the most likely
 * official website. Used as a fallback when a lead has no website at all
 * (e.g. YouTube leads where the About page has no external link).
 * Returns a bare hostname (no protocol) or null.
 */
async function findWebsiteViaSerper(companyName) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey || !companyName?.trim()) return null;

  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: companyName.trim(), num: 5 }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;

    const data = await res.json();
    const organic = data?.organic || [];

    for (const result of organic) {
      if (!result?.link) continue;
      let hostname;
      try {
        hostname = new URL(result.link).hostname.replace(/^www\./, "");
      } catch {
        continue;
      }

      if (isSocialDomain(hostname)) continue;
      if (EXCLUDED_WEBSITE_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`))) continue;

      return hostname;
    }
    return null;
  } catch (err) {
    console.warn(`[EnrichJob] Serper website lookup failed for "${companyName}":`, err.message);
    return null;
  }
}

/**
 * Fallback scraper using Firecrawl API to bypass anti-bot protections
 * and render JavaScript.
 */
async function tryFirecrawlScrape(url) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ url, formats: ["markdown", "html"] })
    });
    if (!res.ok) {
      const errText = await res.text();
      console.warn(`[EnrichJob] Firecrawl API Error (${res.status}):`, errText);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[EnrichJob] Firecrawl fallback failed for ${url}:`, err.message);
    return null;
  }
}

export async function runEnrichJob(input, userId) {
  const { website, name, domain } = input;
  let target = website || domain;
  let discoveredWebsite = null;

  // No website/domain at all, but we have a name (company or channel) —
  // try to find one via Serper before giving up. This is the case for
  // most YouTube leads and any other source that can't provide a website.
  if (!target && name) {
    discoveredWebsite = await findWebsiteViaSerper(name);
    if (discoveredWebsite) {
      target = discoveredWebsite;
    }
  }

  if (!target) return { emails: [], phones: [], work_email: null };

  const url = /^https?:\/\//i.test(target) ? target : `https://${target}`;
  const hostname = new URL(url).hostname.replace(/^www\./, "");

  let html = "";
  let text = "";
  let usingFirecrawl = false;
  let firecrawlData = null;

  try {
    const page = await fetchPage(url);
    if (!page.ok) throw new Error(`HTTP ${page.status}`);
    html = page.html;
    text = htmlToText(html);
  } catch (err) {
    console.warn(`[EnrichJob] Static fetch failed for ${url} (${err.message}), attempting Firecrawl fallback...`);
    usingFirecrawl = true;
  }

  if (usingFirecrawl) {
    firecrawlData = await tryFirecrawlScrape(url);
    if (firecrawlData?.success && firecrawlData.data) {
      html = firecrawlData.data.html || "";
      text = firecrawlData.data.markdown || htmlToText(html);
    } else {
      return {
        emails: [], phones: [], work_email: null, error: `Fetch failed and Firecrawl fallback failed`,
        website: discoveredWebsite || undefined,
      };
    }
  }

  let scrapedEmails = extractEmailsFromText(text).filter((e) => !isSocialDomain(e.split("@")[1] || ""));
  const phoneMatch = text.match(/(\+?\d[\d\s().-]{7,}\d)/);
  const techStack = detectTechStack(html);
  const socialLinks = extractSocialLinks(html, url);
  const metaDescription = extractMetaDescription(html);

  let workEmail = scrapedEmails[0] || null;
  let hunterUsed = false;
  let patternPredicted = false;
  let firecrawlUsed = usingFirecrawl;

  if (!workEmail) {
    const hunterEmail = await tryHunterIo(hostname);
    if (hunterEmail) {
      workEmail = hunterEmail;
      hunterUsed = true;
    }
  }

  // If we STILL don't have an email, and we haven't used Firecrawl yet, use it now as a last resort scrape
  if (!workEmail && !firecrawlUsed) {
    console.log(`[EnrichJob] No email found via static fetch or Hunter for ${url}, attempting Firecrawl fallback...`);
    firecrawlData = await tryFirecrawlScrape(url);
    if (firecrawlData?.success && firecrawlData.data) {
      const fcHtml = firecrawlData.data.html || "";
      const fcText = firecrawlData.data.markdown || htmlToText(fcHtml);
      
      const fcScrapedEmails = extractEmailsFromText(fcText).filter((e) => !isSocialDomain(e.split("@")[1] || ""));
      if (fcScrapedEmails.length > 0) {
        workEmail = fcScrapedEmails[0];
        // Unique merge
        scrapedEmails = [...new Set([...scrapedEmails, ...fcScrapedEmails])];
        firecrawlUsed = true;
      }
    }
  }

  if (!workEmail && name) {
    const parts = name.trim().split(/\s+/);
    const predicted = predictEmailPatterns({ first: parts[0], last: parts[1] }, hostname);
    if (predicted.length) {
      workEmail = predicted[0]; // best-guess pattern — verifyEmailJob.js scores this at a lower confidence threshold
      patternPredicted = true;
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
    // When we discovered the website ourselves (input had none), hand the
    // hostname back so the caller can persist it — otherwise the same
    // lead has no website next time either and this lookup repeats forever.
    website: discoveredWebsite || undefined,
  };
}
