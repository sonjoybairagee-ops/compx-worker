import { ProviderRouter, getCapabilityConfig } from "@compx/scraper-core";
import { googleMapsSerperProvider, type GoogleMapsSerperInput } from "./providers/serper.js";

const PROVIDER_MAP = {
  "google-maps-serper": googleMapsSerperProvider,
};

function buildRouter(): ProviderRouter<GoogleMapsSerperInput, any> {
  const { providers: names } = getCapabilityConfig("google_maps");
  const providers = names.map((n) => {
    const p = (PROVIDER_MAP as Record<string, typeof googleMapsSerperProvider>)[n];
    if (!p) throw new Error(`[google_maps] Unknown provider "${n}" in capability registry`);
    return p;
  });
  return new ProviderRouter<GoogleMapsSerperInput, any>(providers, { capability: "google_maps" });
}

export const googleMapsRouter = buildRouter();
