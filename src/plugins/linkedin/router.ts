import { ProviderRouter, getCapabilityConfig } from "@compx/scraper-core";
import { linkedinApifyProvider, type LinkedinApifyInput } from "./providers/apify.js";

const PROVIDER_MAP = {
  "linkedin-apify": linkedinApifyProvider,
};

function buildRouter(): ProviderRouter<LinkedinApifyInput, any> {
  const { providers: names } = getCapabilityConfig("linkedin");
  const providers = names.map((n) => {
    const p = (PROVIDER_MAP as Record<string, typeof linkedinApifyProvider>)[n];
    if (!p) throw new Error(`[linkedin] Unknown provider "${n}" in capability registry`);
    return p;
  });
  return new ProviderRouter<LinkedinApifyInput, any>(providers, { capability: "linkedin" });
}

export const linkedinRouter = buildRouter();
