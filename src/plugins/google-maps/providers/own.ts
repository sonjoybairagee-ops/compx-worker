import { ProviderError, ProviderErrorType } from "@compx/scraper-core";
import type { SourceProvider, ProviderRunContext } from "@compx/scraper-core";
import { getBrowserPool } from "@compx/scraper-core";
import { GoogleMapsSerpApiInput } from "./serpapi.js"; // Reuse input interface

async function fetchFromOwnPlaywright(input: GoogleMapsSerpApiInput, ctx: ProviderRunContext): Promise<any[]> {
  const { query, maxResults } = input;
  const { logger } = ctx;

  await logger.log(`Fetching from Own Playwright Scraper for: "${query}"`);

  // Acquire a playwright context lease from the shared pool
  const pool = getBrowserPool();
  const lease = await pool.acquireContext();
  const page = await lease.context.newPage();

  try {
    // 1. Navigate to Google Maps Search
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { waitUntil: "domcontentloaded" });

    // 2. Wait for results to load (either a list or a single place)
    try {
      await page.waitForSelector('div[role="article"]', { timeout: 15000 });
    } catch (e) {
      throw new Error("No results found or page took too long to load");
    }

    // 3. Simple basic extraction (this is a starting point, DOM often changes!)
    const results = await page.evaluate(() => {
      const extracted: any[] = [];
      const articles = Array.from(document.querySelectorAll('div[role="article"]'));
      
      for (const item of articles) {
        const title = item.getAttribute('aria-label') || "";
        if (!title) continue;
        
        // Find a link that might be the website
        const links = Array.from(item.querySelectorAll('a'));
        let website = "";
        for (const link of links) {
          const href = link.href;
          if (href && href.startsWith("http") && !href.includes("google.com")) {
            website = href;
            break;
          }
        }

        extracted.push({
          title,
          website: website || null,
          phoneNumber: null, // Advanced: Requires clicking each item to see phone
          address: null, // Advanced: Extracted from inner text
          place_id: title, // Use title as a fallback dedup ID
        });
      }
      return extracted;
    });

    // 4. Provider Result Validation (Point 1)
    if (results.length === 0) {
      throw new Error("Playwright Validation Failed: 0 results returned from DOM.");
    }
    
    // Validate minimum results and required fields
    const validResults = results.filter(r => r.title && r.title.trim().length > 0);
    if (validResults.length < 3 && maxResults >= 3) {
      throw new Error(`Playwright Validation Failed: Only found ${validResults.length} valid results, expected more. Triggering fallback.`);
    }

    return validResults.slice(0, maxResults);
  } catch (err: any) {
    await logger.log(`Own Playwright fetch failed: ${err.message}`);
    throw err; // The Router will catch this and gracefully fallback to SerpApi
  } finally {
    // Always close the page and release the context back to the pool
    await page.close().catch(() => {});
    await lease.release();
  }
}

export const googleMapsOwnProvider: SourceProvider<GoogleMapsSerpApiInput, any> = {
  name: "google-maps-own",
  fetch: fetchFromOwnPlaywright,
};
