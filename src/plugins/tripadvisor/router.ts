import { ProviderRouter, getCapabilityConfig } from "@compx/scraper-core";
import { tripadvisorSerpApiProvider, type TripadvisorProviderInput } from "./providers/serpapi.js";

const PROVIDER_MAP = {
  "tripadvisor-serpapi": tripadvisorSerpApiProvider,
};

function buildRouter(): ProviderRouter<TripadvisorProviderInput, any> {
  const { providers: names } = getCapabilityConfig("tripadvisor");
  const providers = names.map((n) => {
    const p = (PROVIDER_MAP as Record<string, typeof tripadvisorSerpApiProvider>)[n];
    if (!p) throw new Error(`[tripadvisor] Unknown provider "${n}" in capability registry`);
    return p;
  });
  return new ProviderRouter<TripadvisorProviderInput, any>(providers, { capability: "tripadvisor" });
}

export const tripadvisorRouter = buildRouter();
