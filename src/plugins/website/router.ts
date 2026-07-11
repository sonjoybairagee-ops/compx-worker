import { ProviderRouter, getCapabilityConfig } from "@compx/scraper-core";
import { websiteHybridCrawlerProvider, type WebsiteHybridCrawlerInput } from "./providers/hybrid-crawler.js";

const PROVIDER_MAP = {
  "website-hybrid-crawler": websiteHybridCrawlerProvider,
};

function buildRouter(): ProviderRouter<WebsiteHybridCrawlerInput, any> {
  const { providers: names } = getCapabilityConfig("website");
  const providers = names.map((n) => {
    const p = (PROVIDER_MAP as Record<string, typeof websiteHybridCrawlerProvider>)[n];
    if (!p) throw new Error(`[website] Unknown provider "${n}" in capability registry`);
    return p;
  });
  return new ProviderRouter<WebsiteHybridCrawlerInput, any>(providers, { capability: "website" });
}

export const websiteRouter = buildRouter();
