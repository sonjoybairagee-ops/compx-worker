import { ProviderRouter, getCapabilityConfig } from "@compx/scraper-core";
import { youtubeAboutPageProvider, type YoutubeAboutPageInput } from "./providers/about-page-scraper.js";

const PROVIDER_MAP = {
  "youtube-about-page-scraper": youtubeAboutPageProvider,
};

function buildRouter(): ProviderRouter<YoutubeAboutPageInput, Record<string, any>> {
  const { providers: names } = getCapabilityConfig("youtube");
  const providers = names.map((n) => {
    const p = (PROVIDER_MAP as Record<string, typeof youtubeAboutPageProvider>)[n];
    if (!p) throw new Error(`[youtube] Unknown provider "${n}" in capability registry`);
    return p;
  });
  return new ProviderRouter<YoutubeAboutPageInput, Record<string, any>>(providers, { capability: "youtube" });
}

export const youtubeRouter = buildRouter();
