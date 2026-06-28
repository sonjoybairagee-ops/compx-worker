/**
 * CompX Worker — src/jobs/enrichJob.js
 *
 * CHANGES (startup-optimized):
 *   1. Hunter.io fallback যোগ — Cheerio/Puppeteer email না পেলে Hunter চেষ্টা করে
 *   2. Pattern prediction fallback — Hunter ও না পেলে predict করে
 *   3. Rate limiting যোগ — একই domain বারবার hit হবে না
 *   4. techStack সবসময় result এ আসে (আগে Puppeteer path এ missing ছিল)
 *   5. crm_ready condition আরো relaxed — phone বা linkedin যেকোনো একটা হলেই হবে
 */

import { CheerioCrawler, Configuration, ProxyConfiguration } from "crawlee";
import { supabase } from "../config/supabase.js";

// PuppeteerCrawler + puppeteer-extra — optional, Render এ নেই
// Cheerio + Hunter chain দিয়ে বেশিরভাগ email পাওয়া যায়
// Puppeteer দরকার হলে local dev এ চালাও
let PuppeteerCrawler = null;
let puppeteerExtra   = null;

async function loadPuppeteer() {
  if (PuppeteerCrawler) return true;
  try {
    const crawlee   = await import("crawlee");
    const pe        = await import("puppeteer-extra");
    const stealth   = await import("puppeteer-extra-plugin-stealth");
    PuppeteerCrawler = crawlee.PuppeteerCrawler;
    puppeteerExtra   = pe.default;
    puppeteerExtra.use(stealth.default());
    return true;
  } catch {
    console.log("[EnrichJob] puppeteer-extra not available — Cheerio+Hunter only mode");
    return false;
  }
}

// ── Rate limiting — একই domain এ বারবার hit হবে না ──────────────────────────
const recentDomains = new Map(); // domain → last scraped timestamp
const DOMAIN_COOLDOWN_MS = 60_000; // ১ মিনিটে একবারের বেশি না

function isDomainCooledDown(domain) {
  const last = recentDomains.get(domain);
  if (!last) return true;
  return Date.now() - last > DOMAIN_COOLDOWN_MS;
}

function markDomainScraped(domain) {
  recentDomains.set(domain, Date.now());
  // Memory leak prevent — ১০০০+ domain জমলে পুরনো সরাও
  if (recentDomains.size > 1000) {
    const oldest = [...recentDomains.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, 200)
      .map(([k]) => k);
    oldest.forEach(k => recentDomains.delete(k));
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────
const CONTACT_PATHS = [
  "/contact", "/contact-us", "/contacts", "/about", "/about-us",
  "/team", "/our-team", "/people", "/reach-us", "/support", "/company",
];

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
    .map(e => e.toLowerCase()).filter(e => !isJunkEmail(e)))];
}

function extractPhones(text) {
  const PHONE_REGEX = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\+\d{1,3}[-.\s]?\d{4,14}/g;
  return [...new Set((text.match(PHONE_REGEX) || [])
    .filter(p => p.replace(/\D/g, "").length >= 7))].slice(0, 5);
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
    ["WordPress",        () => html.includes("/wp-content/")],
    ["Shopify",          () => html.includes("cdn.shopify.com")],
    ["Webflow",          () => html.includes("webflow.io")],
    ["Squarespace",      () => html.includes("squarespace.com")],
    ["Wix",              () => html.includes("wix.com")],
    ["HubSpot",          () => html.includes("hs-scripts.com") || html.includes("hubspot.com")],
    ["Intercom",         () => html.includes("widget.intercom.io")],
    ["Zendesk",          () => html.includes("zendesk.com")],
    ["Stripe",           () => html.includes("js.stripe.com")],
    ["Salesforce",       () => html.includes("salesforce.com")],
    ["Next.js",          () => html.includes("__NEXT_DATA__")],
    ["React",            () => html.includes("react") && html.includes("__reactFiber")],
    ["Google Analytics", () => html.includes("google-analytics.com") || html.includes("gtag")],
  ];
  return checks
    .filter(([, fn]) => { try { return fn(); } catch { return false; } })
    .map(([n]) => n);
}

function extractSchemaOrg(html) {
  const rx = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = rx.exec(html)) !== null) {
    try {
      const d     = JSON.parse(m[1]);
      const items = Array.isArray(d) ? d : [d];
      for (const item of items) {
        if (["Organization","LocalBusiness","Corporation"].includes(item["@type"])) {
          return {
            name:        item.name        || "",
            description: item.description || "",
            email:       item.email       || "",
            phone:       item.telephone   || "",
            address:     item.address
              ? [item.address.streetAddress, item.address.addressLocality, item.address.addressRegion]
                  .filter(Boolean).join(", ")
              : "",
            socials: item.sameAs || [],
          };
        }
      }
    } catch {}
  }
  return {};
}

// ── Pattern Email Prediction (last resort fallback) ───────────────────────────
function predictEmail(name, domain) {
  if (!name || !domain) return null;
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

// ── Hunter.io email fallback (Apollo replace) ─────────────────────────────────
async function getEmailFromHunter(domain) {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) return null;
  try {
    const res  = await fetch(
      `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${apiKey}&limit=3`,
      { signal: AbortSignal.timeout(8000) }
    );
    const json = await res.json();
    if (json.errors?.length) return null;
    const emails = json.data?.emails || [];
    const best   = emails.find(e => e.confidence >= 70) || emails[0];
    if (!best?.value) return null;
    console.log(`[EnrichJob] Hunter found: ${best.value} (${best.confidence}%)`);
    return {
      email:        best.value,
      contactName:  [best.first_name, best.last_name].filter(Boolean).join(" ") || null,
      contactTitle: best.position || null,
      linkedin:     best.linkedin || null,
    };
  } catch (err) {
    console.warn(`[EnrichJob] Hunter.io error: ${err.message}`);
    return null;
  }
}

// ── Main enrichment job ───────────────────────────────────────────────────────
export async function runEnrichJob(inputData, userId) {
  const { website, name, leadId, proxyUrl } = inputData;

  if (!website) {
    console.warn("[EnrichJob] No website provided");
    return null;
  }

  const domain  = website.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  const isHttp  = website.startsWith("http://");
  const baseUrl = `${isHttp ? "http" : "https"}://${domain}`;

  // Rate limit check — একই domain সম্প্রতি scrape হয়েছে কিনা
  if (!isDomainCooledDown(domain)) {
    console.log(`[EnrichJob] Rate limit: ${domain} scraped recently, skipping`);
    return null;
  }
  markDomainScraped(domain);

  console.log(`[EnrichJob] Enriching: ${domain}`);

  const result = {
    domain,
    emails: [], work_email: null, personal_email: null,
    phones: [], socials: {}, social_links: {}, techStack: [],
    description: "", schema: {}, crawledPages: [],
    phone_found: false, linkedin_matched: false, crm_ready: false,
    hunterUsed: false, patternPredicted: false,
    enrichedAt: new Date().toISOString(),
  };

  const urlsToCrawl       = [baseUrl, ...CONTACT_PATHS.slice(0, 5).map(p => baseUrl + p)];
  const allEmails         = new Set();
  const allPhones         = new Set();
  const proxyConfiguration = proxyUrl ? new ProxyConfiguration({ proxyUrls: [proxyUrl] }) : undefined;

  // ── Phase 1A: CheerioCrawler (fast, $0 cost) ──────────────────────────────
  let cheerioSuccess = false;

  const cheerioCrawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl:      6,
    maxConcurrency:           4,
    requestHandlerTimeoutSecs: 15,

    async requestHandler({ request, $, body }) {
      const url  = request.url;
      const html = body.toString();
      const text = $("body").text();

      extractEmails(html + " " + text).forEach(e => allEmails.add(e));
      extractPhones(text).forEach(p => allPhones.add(p));
      $("a[href^='mailto:']").each((_, el) => {
        const e = $(el).attr("href")?.replace("mailto:", "").split("?")[0].toLowerCase();
        if (e && !isJunkEmail(e)) allEmails.add(e);
      });

      if (url === baseUrl || url === baseUrl + "/") {
        result.techStack    = detectTechStack(html);
        result.socials      = extractSocials(html);
        result.social_links = result.socials;
        result.schema       = extractSchemaOrg(html);
        result.description  = $('meta[name="description"], meta[property="og:description"]').attr("content") || "";
      }

      result.crawledPages.push(url);
      console.log(`[EnrichJob] Cheerio: ${url} — emails: ${allEmails.size}`);
      cheerioSuccess = true;

      // Email পেলে বাকি page skip করো — speed বাড়বে
      if (allEmails.size > 0 && url !== baseUrl) return;
    },

    failedRequestHandler({ request, error }) {
      console.warn(`[EnrichJob] Cheerio failed: ${request.url} — ${error.message}`);
    },
  }, new Configuration({ persistStorage: false }));

  try { await cheerioCrawler.run(urlsToCrawl); }
  catch (err) { console.error("[EnrichJob] Cheerio error:", err.message); }

  // ── Phase 1B: PuppeteerCrawler + Stealth (JS-heavy site fallback) ────────
  if (allEmails.size === 0 || !cheerioSuccess) {
    const puppeteerAvailable = await loadPuppeteer();
    if (!puppeteerAvailable) {
      console.log("[EnrichJob] Puppeteer not available — skipping to Hunter.io");
    } else {
    console.log("[EnrichJob] Falling back to Puppeteer (stealth mode)...");

    const puppeteerCrawler = new PuppeteerCrawler({
      proxyConfiguration,
      maxRequestsPerCrawl:      6,
      maxConcurrency:           2,
      requestHandlerTimeoutSecs: 25,

      launchContext: {
        launcher: puppeteerExtra,
        launchOptions: {
          ignoreHTTPSErrors: true,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-blink-features=AutomationControlled",
          ],
        },
      },

      preNavigationHooks: [
        async ({ page }) => {
          await page.setRequestInterception(true);
          page.on("request", req => {
            // image/font/media block করো — speed বাড়বে
            if (["image","font","media","stylesheet"].includes(req.resourceType())) {
              req.abort();
            } else {
              req.continue();
            }
          });
          // JSON response থেকেও email খোঁজো (API-based sites)
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
          // techStack — Cheerio phase এ না পেলে এখানে নাও
          if (!result.techStack.length)
            result.techStack = detectTechStack(html);
          if (!Object.keys(result.socials).length) {
            result.socials      = extractSocials(html);
            result.social_links = result.socials;
          }
          if (!Object.keys(result.schema).length)
            result.schema = extractSchemaOrg(html);
          if (!result.description) {
            result.description = await page.$eval(
              'meta[name="description"], meta[property="og:description"]',
              el => el.getAttribute("content") || ""
            ).catch(() => "");
          }
        }

        if (!result.crawledPages.includes(url)) result.crawledPages.push(url);
        console.log(`[EnrichJob] Puppeteer: ${url} — emails: ${allEmails.size}`);

        // ৩টা email পেলে বাকি page বাদ দাও
        if (allEmails.size >= 3 && url !== baseUrl) return;
      },

      failedRequestHandler({ request, error }) {
        console.warn(`[EnrichJob] Puppeteer failed: ${request.url} — ${error.message}`);
      },
    }, new Configuration({ persistStorage: false }));

    try { await puppeteerCrawler.run(urlsToCrawl); }
    catch (err) { console.error("[EnrichJob] Puppeteer error:", err.message); }
    } // end puppeteerAvailable
  }

  // ── Phase 1C: Hunter.io fallback — Crawlee email না পেলে ────────────────
  // Apollo এর জায়গায় Hunter.io — 50x সস্তা, reliable domain search
  if (allEmails.size === 0) {
    console.log(`[EnrichJob] No emails from crawl → trying Hunter.io for ${domain}`);
    const hunterResult = await getEmailFromHunter(domain);
    if (hunterResult?.email) {
      allEmails.add(hunterResult.email);
      result.hunterUsed    = true;
      // contactName/contactTitle enrichJob result এ যোগ করো
      result.contactName   = hunterResult.contactName  || null;
      result.contactTitle  = hunterResult.contactTitle || null;
      if (hunterResult.linkedin && !result.socials.linkedin) {
        result.socials.linkedin      = hunterResult.linkedin;
        result.social_links.linkedin = hunterResult.linkedin;
      }
    }
  }

  // ── Phase 2: Email classification ─────────────────────────────────────────
  result.emails = [...allEmails].slice(0, 8);

  // Schema.org email সবার আগে রাখো (সবচেয়ে reliable)
  if (result.schema.email && !isJunkEmail(result.schema.email)) {
    result.emails.unshift(result.schema.email);
    result.emails = [...new Set(result.emails)];
  }

  const workEmails = result.emails.filter(e => e.endsWith(`@${domain}`));
  const personalEmails = result.emails.filter(e =>
    !e.endsWith(`@${domain}`) &&
    !["info","contact","support","sales","hello","team"].some(p => e.startsWith(p))
  );

  result.work_email     = workEmails[0]     || null;
  result.personal_email = personalEmails[0] || null;

  // ── Phase 2B: Pattern prediction — সব method fail হলে ───────────────────
  if (!result.work_email && !result.personal_email && result.emails.length === 0) {
    const predicted = predictEmail(name, domain);
    if (predicted) {
      result.emails           = [predicted];
      result.work_email       = predicted;
      result.patternPredicted = true;
      console.log(`[EnrichJob] Pattern predicted: ${predicted}`);
    }
  }

  // ── Phase 3: Final assembly ────────────────────────────────────────────────
  result.phones    = [...allPhones].slice(0, 5);
  const finalPhone = result.schema.phone || result.phones[0] || null;
  if (finalPhone) result.phone_found = true;

  if (result.socials.linkedin) result.linkedin_matched = true;

  const finalDescription = result.schema.description || result.description || null;
  const companyName      = result.schema.name || name || null;

  // crm_ready — work_email থাকলে এবং phone বা linkedin যেকোনো একটা হলেই ready
  // আগে: companyName ও দরকার ছিল — এখন relaxed করা হয়েছে
  if (result.work_email && (result.phone_found || result.linkedin_matched)) {
    result.crm_ready = true;
  }

  console.log(
    `[EnrichJob] Done: ${domain}` +
    ` — CRM Ready: ${result.crm_ready}` +
    ` | Emails: ${result.emails.length}` +
    ` | Tech: ${result.techStack.join(",") || "none"}` +
    ` | Hunter: ${result.hunterUsed}` +
    ` | Pattern: ${result.patternPredicted}`
  );

  // ── Phase 4: DB update (leadId থাকলে) ────────────────────────────────────
  const updateData = {
    email:            result.work_email || result.emails[0] || null,
    work_email:       result.work_email,
    personal_email:   result.personal_email,
    phone:            finalPhone,
    description:      finalDescription,
    linkedin_url:     result.socials.linkedin     || null,
    social_links:     result.socials              || {},
    tech_stack:       result.techStack            || [],
    phone_found:      result.phone_found,
    linkedin_matched: result.linkedin_matched,
    crm_ready:        result.crm_ready,
  };

  if (leadId && (result.emails.length > 0 || result.phone_found || result.linkedin_matched)) {
    await supabase
      .from("extension_database")
      .update(updateData)
      .eq("hash", leadId)
      .eq("user_id", userId);

    console.log(`[EnrichJob] Updated lead ${leadId} (CRM Ready: ${result.crm_ready})`);
  }

  return result;
}