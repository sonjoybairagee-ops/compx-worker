import { enrichLead } from "./intelligence";

export async function handleScrape(data: any) {
  // Simulating scraping with mock data as instructed in Phase 8 Step 5
  const scraped = {
    company: "Demo Company",
    website: data.url,
    email: "test@demo.com",
    hiring_signal: true,
  };

  // INTELLIGENCE LAYER
  const enriched = enrichLead(scraped);

  return enriched;
}
