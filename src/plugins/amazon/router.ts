import { ProviderRouter, getCapabilityConfig } from "@compx/scraper-core";
import { amazonSerpApiProvider, type AmazonProviderInput } from "./providers/serpapi.js";

const PROVIDER_MAP = {
  "amazon-serpapi": amazonSerpApiProvider,
};

function buildRouter(): ProviderRouter<AmazonProviderInput, any> {
  const { providers: names } = getCapabilityConfig("amazon");
  const providers = names.map((n) => {
    const p = (PROVIDER_MAP as Record<string, typeof amazonSerpApiProvider>)[n];
    if (!p) throw new Error(`[amazon] Unknown provider "${n}" in capability registry`);
    return p;
  });
  return new ProviderRouter<AmazonProviderInput, any>(providers, { capability: "amazon" });
}

// Built once per process — capability registry doesn't change mid-run.
export const amazonRouter = buildRouter();
