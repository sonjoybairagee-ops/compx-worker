import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import { supabase } from "../config/supabase.js";

chromium.use(stealth());

const humanDelay = (min = 800, max = 2500) =>
  new Promise(r => setTimeout(r, min + Math.random() * (max - min)));

async function logToTerminal(jobId, message) {
  console.log(`[DiscoverScrape ${jobId}] ${message}`);
  // Append to job's terminal_logs in Supabase
  try {
    const { data } = await supabase.from("jobs").select("terminal_logs").eq("id", jobId).single();
    const logs = data?.terminal_logs || [];
    logs.push({ time: new Date().toISOString(), message });
    await supabase.from("jobs").update({ terminal_logs: logs }).eq("id", jobId);
  } catch(e) {}
}

export async function runDiscoverScrape(inputData, userId, jobId, proxy) {
  const { keyword, location } = inputData;
  const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(`${keyword} in ${location}`)}`;

  await logToTerminal(jobId, `Starting stealth browser...`);
  
  const args = ['--no-sandbox', '--disable-setuid-sandbox'];
  if (proxy && proxy.url) {
    args.push(`--proxy-server=${proxy.url}`);
    await logToTerminal(jobId, `[Proxy] Routed via secure network proxy`);
  }

  const browser = await chromium.launch({
    headless: true, // or "new"
    args: args
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  });

  const page = await context.newPage();
  
  let results = [];

  try {
    await logToTerminal(jobId, `Navigating to Google Maps for "${keyword} in ${location}"...`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await humanDelay(2000, 3000);

    // Handle initial Captcha or Consent if any
    const isCaptcha = await page.$('form[action*="Captcha"]');
    if (isCaptcha) {
      await logToTerminal(jobId, `[WARNING] CAPTCHA detected. Attempting to bypass or wait...`);
      await humanDelay(5000, 8000);
    }

    await logToTerminal(jobId, `Extracting business listings (Scrolling feed)...`);

    // Wait for the feed
    try {
      await page.waitForSelector('div[role="feed"]', { timeout: 10000 });
      for (let i = 0; i < 4; i++) {
        await page.evaluate(() => {
          const feed = document.querySelector('div[role="feed"]');
          if (feed) feed.scrollBy(0, 1000);
        });
        await humanDelay(1000, 1500);
      }
    } catch(e) {
      await logToTerminal(jobId, `[WARNING] Feed not found, might be a direct result or slow load.`);
    }

    const cards = await page.$$('a[href*="/maps/place/"]');
    await logToTerminal(jobId, `Found ${cards.length} potential businesses. Starting extraction...`);

    const maxCards = Math.min(cards.length, 10); // Extract up to 10 for demo/speed

    for (let i = 0; i < maxCards; i++) {
      try {
        await cards[i].click();
        await humanDelay(1500, 2500);

        const data = await page.evaluate(() => {
          const getText = sel => document.querySelector(sel)?.innerText?.trim() || "";
          const getAttr = (sel, attr) => document.querySelector(sel)?.getAttribute(attr) || "";

          return {
            name:     getText("h1.DUwDvf") || getText("h1"),
            phone:    getAttr('button[data-item-id^="phone:tel:"]', "data-item-id")?.replace("phone:tel:", "") || getText(".phone"),
            address:  getText('button[data-item-id="address"]'),
            website:  getAttr('a[data-item-id="authority"]', "href"),
            rating:   getText(".F7nice span"),
            industry: getText(".DkEaL"),
          };
        });

        if (data.name) {
          data.id = `map_${Date.now()}_${i}`;
          data.score = 40; // Initial score, updated later
          data.hiring = false;
          results.push(data);
          await logToTerminal(jobId, `Extracted: ${data.name}`);
        }
      } catch(e) {
        // skip if card errors
      }
    }

    // ENRICHMENT PHASE (Job Chaining logic)
    await logToTerminal(jobId, `Starting Website Enrichment Phase...`);
    for (const lead of results) {
      if (lead.website) {
        await logToTerminal(jobId, `Visiting ${lead.website} for contact enrichment...`);
        try {
          const enrichPage = await context.newPage();
          // Timeout fast so we don't hang
          await enrichPage.goto(lead.website, { waitUntil: 'domcontentloaded', timeout: 15000 });
          
          // Basic email regex scraper
          const emails = await enrichPage.evaluate(() => {
            const text = document.body.innerText;
            const match = text.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi);
            return match ? [...new Set(match)] : [];
          });

          if (emails.length > 0) {
            lead.email = emails[0];
            await logToTerminal(jobId, `Found contact email for ${lead.name}: ${lead.email}`);
          } else {
            await logToTerminal(jobId, `No email found on homepage for ${lead.name}`);
          }
          await enrichPage.close();
        } catch(err) {
          await logToTerminal(jobId, `Failed to enrich ${lead.website}: ${err.message}`);
        }
      }

      let finalScore = 40;
      if (lead.website) finalScore += 20;
      if (lead.phone) finalScore += 15;
      if (lead.email) finalScore += 25;
      if (lead.rating && parseFloat(lead.rating) >= 4.0) finalScore += 10;
      lead.score = Math.min(99, finalScore);
    }

    await logToTerminal(jobId, `Saving ${results.length} enriched leads to database...`);
    
    // In a real app we'd save to extension_database here too if wanted, 
    // but for discover search, returning them in output_data of the job is enough to show on frontend.
    
  } catch (error) {
    await logToTerminal(jobId, `[ERROR] ${error.message}`);
    throw error;
  } finally {
    await browser.close();
    await logToTerminal(jobId, `Job Complete.`);
  }

  return { count: results.length, leads: results };
}
