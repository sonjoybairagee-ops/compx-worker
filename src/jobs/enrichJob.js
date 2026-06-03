/**
 * CompX Worker — src/jobs/enrichJob.js
 * Website enrichment job using Crawlee + network interception
 *
 * Apollo.io method:
 * 1. Crawl website + contact/about pages
 * 2. Intercept network requests for API data
 * 3. Extract emails, phones, social links, tech stack
 * 4. AI summarize company description
 * 5. Store enriched data back to Supabase
 */

import { PuppeteerCrawler, CheerioCrawler, Configuration, ProxyConfiguration } from "crawlee";
import { supabase } from "../config/supabase.js";

// Contact page paths to try
const CONTACT_PATHS = [
  "/contact", "/contact-us", "/contacts", "/about", "/about-us",
  "/team", "/our-team", "/people", "/reach-us", "/support", "/company",
];

// Junk email filter
const JUNK_DOMAINS = new Set([
  "example.com","sentry.io","wixpress.com","w3.org","schema.org",
  "2x.png","1x.png","amazonaws.com","cloudfront.net",
]);
const JUNK_PREFIXES = new Set([
  "noreply","no-reply","donotreply","mailer-daemon","postmaster","webmaster",
]);

function isJunkEmail(email) {
  if (!email?.includes("@")) return true;
  const [prefix, domain] = email.toLowerCase().split("@");
  if (!domain) return true;
  if ([...JUNK_DOMAINS].some(d => domain.includes(d))) return true;
  if ([...JUNK_PREFIXES].some(p => prefix.startsWith(p))) return true;
  if (/\.(png|jpg|gif|svg|css|js|webp)$/i.test(email)) return true;
  return false;
}

const EMAIL_REGEX = /([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g;

function extractEmails(text) {
  return [...new Set((text.match(EMAIL_REGEX) || [])
    .map(e => e.toLowerCase())
    .filter(e => !isJunkEmail(e))
  )];
}

function extractPhones(text) {
  const PHONE_REGEX = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\+\d{1,3}[-.\s]?\d{4,14}/g;
  return [...new Set((text.match(PHONE_REGEX) || [])
    .filter(p => p.replace(/\D/g, "").length >= 7)
  )].slice(0, 5);
}

function extractSocials(html) {
  const patterns = {
    linkedin:  /linkedin\.com\/(company|in)\/([^/?#"'\s<>]+)/i,
    twitter:   /(?:twitter|x)\.com\/([^/?#"'\s<>]+)/i,
    facebook:  /facebook\.com\/([^/?#"'\s<>]+)/i,
    instagram: /instagram\.com\/([^/?#"'\s<>]+)/i,
    youtube:   /youtube\.com\/(channel|c|@|user)\/([^/?#"'\s<>]+)/i,
  };
  const result = {};
  for (const [platform, rx] of Object.entries(patterns)) {
    const m = html.match(rx);
    if (m) result[platform] = `https://www.${platform === "twitter" ? "x" : platform}.com/${m[2] || m[1]}`;
  }
  return result;
}

function detectTechStack(html) {
  const checks = [
    ["WordPress",   () => html.includes("/wp-content/")],
    ["Shopify",     () => html.includes("cdn.shopify.com")],
    ["Webflow",     () => html.includes("webflow.io")],
    ["Squarespace", () => html.includes("squarespace.com")],
    ["Wix",         () => html.includes("wix.com")],
    ["HubSpot",     () => html.includes("hs-scripts.com") || html.includes("hubspot.com")],
    ["Intercom",    () => html.includes("widget.intercom.io")],
    ["Zendesk",     () => html.includes("zendesk.com")],
    ["Stripe",      () => html.includes("js.stripe.com")],
    ["Salesforce",  () => html.includes("salesforce.com")],
    ["Next.js",     () => html.includes("__NEXT_DATA__")],
    ["React",       () => html.includes("react") && html.includes("__reactFiber")],
    ["Google Analytics", () => html.includes("google-analytics.com") || html.includes("gtag")],
  ];
  return checks.filter(([, fn]) => { try { return fn(); } catch { return false; } }).map(([n]) => n);
}

function extractSchemaOrg(html) {
  const rx = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = rx.exec(html)) !== null) {
    try {
      const d = JSON.parse(m[1]);
      const items = Array.isArray(d) ? d : [d];
      for (const item of items) {
        if (["Organization","LocalBusiness","Corporation"].includes(item["@type"])) {
          return {
            name:        item.name || "",
            description: item.description || "",
            email:       item.email || "",
            phone:       item.telephone || "",
            address:     item.address
              ? [item.address.streetAddress, item.address.addressLocality, item.address.addressRegion].filter(Boolean).join(", ")
              : "",
            socials: item.sameAs || [],
          };
        }
      }
    } catch {}
  }
  return {};
}

// ── Main enrichment job ───────────────────────────────────────────────────────
export async function runEnrichJob(inputData, userId) {
  const { website, name, leadId, hints = {}, proxyUrl } = inputData;

  if (!website) {
    console.warn("[EnrichJob] No website provided");
    return null;
  }

  const domain = website.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  const baseUrl = `https://${domain}`;

  console.log(`[EnrichJob] Enriching: ${domain}`);

  const result = {
    domain,
    emails:      [],
    work_email:  null,
    personal_email: null,
    phones:      [],
    socials:     {},
    techStack:   [],
    description: "",
    schema:      {},
    crawledPages: [],
    // Badges
    phone_found: false,
    linkedin_matched: false,
    crm_ready:   false,
    enrichedAt:  new Date().toISOString(),
  };

  // Pages to crawl
  const urlsToCrawl = [baseUrl];
  for (const path of CONTACT_PATHS.slice(0, 5)) {
    urlsToCrawl.push(baseUrl + path);
  }

  const allEmails = new Set();
  const allPhones = new Set();

  // Proxy configuration
  const proxyConfiguration = proxyUrl ? new ProxyConfiguration({ proxyUrls: [proxyUrl] }) : undefined;

  // ── Crawlee CheerioCrawler (Phase 1A: Fast HTML Scrape) ───────────────────
  let cheerioSuccess = false;
  
  const cheerioCrawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl: 6,
    maxConcurrency: 4,
    requestHandlerTimeoutSecs: 15,
    async requestHandler({ request, $, body }) {
      const url = request.url;
      const html = body.toString();
      const text = $("body").text();

      extractEmails(html + " " + text).forEach(e => allEmails.add(e));
      extractPhones(text).forEach(p => allPhones.add(p));

      $("a[href^='mailto:']").each((_, el) => {
        const e = $(el).attr("href")?.replace("mailto:", "").split("?")[0].toLowerCase();
        if (e && !isJunkEmail(e)) allEmails.add(e);
      });

      if (url === baseUrl || url === baseUrl + "/") {
        result.techStack = detectTechStack(html);
        result.socials   = extractSocials(html);
        result.schema    = extractSchemaOrg(html);
        result.description = $('meta[name="description"], meta[property="og:description"]').attr("content") || "";
      }

      result.crawledPages.push(url);
      console.log(`[EnrichJob] Cheerio crawled ${url} — emails: ${allEmails.size}`);
      cheerioSuccess = true;
    },
    failedRequestHandler({ request, error }) {
      console.warn(`[EnrichJob] Cheerio Failed: ${request.url} — ${error.message}`);
    },
  }, new Configuration({ persistStorage: false }));

  try {
    await cheerioCrawler.run(urlsToCrawl);
  } catch (err) {
    console.error("[EnrichJob] Cheerio error:", err.message);
  }

  // ── Crawlee PuppeteerCrawler (Phase 1B: SPA Fallback) ─────────────────────
  if (allEmails.size === 0 || !cheerioSuccess) {
    console.log(`[EnrichJob] Cheerio found no data or failed. Falling back to Puppeteer...`);
    const puppeteerCrawler = new PuppeteerCrawler({
      proxyConfiguration,
      maxRequestsPerCrawl: 6,
      maxConcurrency: 2,
      requestHandlerTimeoutSecs: 25,
      preNavigationHooks: [
        async ({ page }) => {
          await page.setRequestInterception(true);
          page.on("request", req => {
            const rt = req.resourceType();
            if (["image","font","media","stylesheet"].includes(rt)) req.abort();
            else req.continue();
          });
          page.on("response", async res => {
            try {
              const ct = res.headers()["content-type"] || "";
              if (ct.includes("json") && res.status() === 200) {
                const text = await res.text().catch(() => "");
                extractEmails(text).forEach(e => allEmails.add(e));
              }
            } catch {}
          });
        },
      ],
      async requestHandler({ request, page }) {
        const url  = request.url;
        const html = await page.content();
        const text = await page.evaluate(() => document.body?.innerText || "");

        extractEmails(html + " " + text).forEach(e => allEmails.add(e));
        extractPhones(text).forEach(p => allPhones.add(p));

        const mailtos = await page.$$eval("a[href^='mailto:']", els =>
          els.map(el => el.href.replace("mailto:", "").split("?")[0].toLowerCase())
        );
        mailtos.filter(e => !isJunkEmail(e)).forEach(e => allEmails.add(e));

        if (url === baseUrl || url === baseUrl + "/") {
          if (!result.techStack.length) result.techStack = detectTechStack(html);
          if (!Object.keys(result.socials).length) result.socials = extractSocials(html);
          if (!Object.keys(result.schema).length) result.schema = extractSchemaOrg(html);
          if (!result.description) {
            result.description = await page.$eval(
              'meta[name="description"], meta[property="og:description"]',
              el => el.getAttribute("content") || ""
            ).catch(() => "");
          }
        }
        if (!result.crawledPages.includes(url)) result.crawledPages.push(url);
        console.log(`[EnrichJob] Puppeteer crawled ${url} — emails: ${allEmails.size}`);
        if (allEmails.size >= 3 && url !== baseUrl) return;
      },
      failedRequestHandler({ request, error }) {
        console.warn(`[EnrichJob] Puppeteer Failed: ${request.url} — ${error.message}`);
      },
    }, new Configuration({ persistStorage: false }));

    try {
      await puppeteerCrawler.run(urlsToCrawl);
    } catch (err) {
      console.error("[EnrichJob] Puppeteer Crawler error:", err.message);
    }
  }

  // ── Phase 2: Email Discovery & Classification ─────────────────────────────
  result.emails = [...allEmails].slice(0, 8);
  if (result.schema.email && !isJunkEmail(result.schema.email)) {
    result.emails.unshift(result.schema.email);
    result.emails = [...new Set(result.emails)];
  }

  const workEmails = result.emails.filter(e => e.endsWith(`@${domain}`));
  const personalEmails = result.emails.filter(e => !e.endsWith(`@${domain}`) && !e.startsWith("info") && !e.startsWith("contact") && !e.startsWith("support") && !e.startsWith("sales"));
  
  result.work_email = workEmails[0] || null;
  result.personal_email = personalEmails[0] || null;

  // ── Phase 3: Phone Lookup ────────────────────────────────────────────────
  result.phones = [...allPhones].slice(0, 5);
  const finalPhone = result.schema.phone || result.phones[0] || null;
  if (finalPhone) result.phone_found = true;

  // ── Phase 4: Social Profiles ─────────────────────────────────────────────
  if (result.socials.linkedin) result.linkedin_matched = true;

  // ── Phase 5: Contact Details ─────────────────────────────────────────────
  const finalDescription = result.schema.description || result.description || null;
  const companyName = result.schema.name || name || null;

  // ── Phase 6: Badge Assignment & CRM Readiness ────────────────────────────
  // CRM ready if it has at least a work email, company name, and either phone or linkedin
  if (result.work_email && companyName && (result.phone_found || result.linkedin_matched)) {
    result.crm_ready = true;
  }

  console.log(`[EnrichJob] Done: ${domain} — CRM Ready: ${result.crm_ready}, Emails: ${result.emails.length}`);

  // ── Store enriched data back to Supabase ──────────────────────────────────
  if (leadId && (result.emails.length > 0 || result.phone_found || result.linkedin_matched)) {
    const updateData = {
      email:            result.work_email || result.emails[0] || null,
      work_email:       result.work_email,
      personal_email:   result.personal_email,
      phone:            finalPhone,
      description:      finalDescription,
      linkedin_url:     result.socials.linkedin || null,
      phone_found:      result.phone_found,
      linkedin_matched: result.linkedin_matched,
      crm_ready:        result.crm_ready
    };

    // Update by hash (leadId is the hash from background.js)
    await supabase
      .from("extension_database")
      .update(updateData)
      .eq("hash", leadId)
      .eq("user_id", userId);

    console.log(`[EnrichJob] Updated lead ${leadId} with badges (CRM Ready: ${result.crm_ready})`);
  }

  return result;
}
