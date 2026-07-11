import { ProviderRouter, getCapabilityConfig } from "@compx/scraper-core";
import { ebaySerpApiProvider, type EbayProviderInput } from "./providers/serpapi.js";

const PROVIDER_MAP = {
  "ebay-serpapi": ebaySerpApiProvider,
};

function buildRouter(): ProviderRouter<EbayProviderInput, any> {
  const { providers: names } = getCapabilityConfig("ebay");
  const providers = names.map((n) => {
    const p = (PROVIDER_MAP as Record<string, typeof ebaySerpApiProvider>)[n];
    if (!p) throw new Error(`[ebay] Unknown provider "${n}" in capability registry`);
    return p;
  });
  return new ProviderRouter<EbayProviderInput, any>(providers, { capability: "ebay" });
}

export const ebayRouter = buildRouter();
