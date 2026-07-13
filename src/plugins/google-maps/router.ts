import { ProviderRouter, getCapabilityConfig } from "@compx/scraper-core";
import { googleMapsSerpApiProvider } from "./providers/serpapi.js";
import { googleMapsOwnProvider } from "./providers/own.js";
import type { GoogleMapsSerpApiInput } from "./providers/serpapi.js";

const PROVIDER_MAP = {
  "google-maps-own": googleMapsOwnProvider,
  "google-maps-serpapi": googleMapsSerpApiProvider,
};

function buildRouter(): ProviderRouter<GoogleMapsSerpApiInput, any> {
  const { providers: names } = getCapabilityConfig("google_maps");
  const providers = names.map((n) => {
    const p = (PROVIDER_MAP as Record<string, typeof googleMapsSerpApiProvider>)[n];
    if (!p) throw new Error(`[google_maps] Unknown provider "${n}" in capability registry`);
    return p;
  });
  return new ProviderRouter<GoogleMapsSerpApiInput, any>(providers, { capability: "google_maps" });
}

export const googleMapsRouter = buildRouter();
