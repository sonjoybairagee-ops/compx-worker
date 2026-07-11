import { ProviderRouter, getCapabilityConfig } from "@compx/scraper-core";
import { facebookSerpApiProvider, type FacebookProviderInput } from "./providers/serpapi.js";

const PROVIDER_MAP = {
  "facebook-serpapi": facebookSerpApiProvider,
};

function buildRouter(): ProviderRouter<FacebookProviderInput, any> {
  const { providers: names } = getCapabilityConfig("facebook");
  const providers = names.map((n) => {
    const p = (PROVIDER_MAP as Record<string, typeof facebookSerpApiProvider>)[n];
    if (!p) throw new Error(`[facebook] Unknown provider "${n}" in capability registry`);
    return p;
  });
  return new ProviderRouter<FacebookProviderInput, any>(providers, { capability: "facebook" });
}

export const facebookRouter = buildRouter();
