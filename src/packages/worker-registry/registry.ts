/**
 * workers/registry/registry.ts
 *
 * Phase 3 from the roadmap. Replaces dispatcher.js's hardcoded
 * DISCOVER_SOURCES set + classifyJobType() if/else chain — that pattern
 * meant every new source touched dispatcher.js AND index.js's
 * SCRAPE_JOB_NAMES set. Now: one registration call per plugin, here only.
 *
 * MIGRATION STATUS — all roadmap sources + amazon + facebook migrated:
 *   ✅ website        — /plugins/website      (no browser)
 *   ✅ google_maps     — /plugins/google-maps  (browser-pool)
 *   ✅ instagram        — /plugins/instagram    (browser-pool + session-manager)
 *   ✅ linkedin         — /plugins/linkedin     (browser-pool + session-manager)
 *   ✅ youtube          — /plugins/youtube      (fetch first, browser-pool fallback)
 *   ✅ amazon           — /plugins/amazon      (no browser)
 *   ✅ facebook         — /plugins/facebook    (browser-pool + session-manager)
 *
 * Adding facebook required ZERO changes to dispatcher.js, index.js, or
 * scraper-core — only a new plugin folder + this one registration line.
 * That's the whole point of the plugin-based design over the old
 * Apify-actor-style approach.
 *
 * ⚠️ Before this goes live, two things still need to happen OUTSIDE this
 * worker repo, in the app:
 *   1. `lib/platforms.ts` — add "facebook" to the ScrapeSource union type
 *      and a DISCOVER_PLATFORMS entry (so the UI shows it as a choice).
 *   2. `lib/planPlatforms.ts` — add "facebook" to whichever PLAN_PLATFORMS
 *      tiers should have it (Agency at minimum, matching the
 *      facebook_scraping default tier in scraper-core/access.ts). It was
 *      deliberately kept OUT of every tier until the plugin existed — now
 *      that it does, this is the one-line swap the earlier migration notes
 *      described.
 * Until both are done, a user has no way to actually request a Facebook
 * job even though the worker can now run one.
 *
 * There is no legacy fallback path — dispatcher.js and index.js both throw
 * a clear "No plugin registered for source ..." error on a registry miss.
 * Every discover_scrape source MUST be registered here or the job fails
 * loudly.
 */

import type { SourcePlugin } from "@compx/scraper-core";
export type { SourcePlugin, PluginContext, PluginResult } from "@compx/scraper-core";
import { websitePlugin } from "@compx/plugin-website";
import { googleMapsPlugin } from "@compx/plugin-google-maps";
import { instagramPlugin } from "@compx/plugin-instagram";
import { linkedinPlugin } from "@compx/plugin-linkedin";
import { youtubePlugin } from "@compx/plugin-youtube";
import { amazonPlugin } from "@compx/plugin-amazon";
import { facebookPlugin } from "@compx/plugin-facebook";
import { ebayPlugin } from "@compx/plugin-ebay";
import { tripadvisorPlugin } from "@compx/plugin-tripadvisor";

const registry = new Map<string, SourcePlugin>();

export function registerPlugin(plugin: SourcePlugin): void {
  if (registry.has(plugin.name)) {
    console.warn(`[Registry] Overwriting existing plugin registration for "${plugin.name}"`);
  }
  registry.set(plugin.name, plugin);
}

export function getPlugin(source: string): SourcePlugin | undefined {
  return registry.get(source);
}

export function listPlugins(): string[] {
  return Array.from(registry.keys());
}

// ── Register all migrated plugins ────────────────────────────────────────────
registerPlugin(websitePlugin);
// ⚠️ ALIAS FIX: SCRAPE_JOB_NAMES in worker/src/index.js has "websites-scrape"
// (plural) while every other source's job-name/plugin-name pair matches
// singular-to-singular (e.g. "amazon-scrape" → "amazon"). Whatever builds
// input_data.source from the job name for website jobs ends up sending
// "websites" instead of "website", which caused every discover_scrape
// website job to fail with "No plugin registered for source 'websites'"
// and land in the DLQ. Registering the same plugin under both keys fixes
// this without touching the job-producing code. Remove this alias only
// after the root cause (wherever input_data.source is derived) is fixed
// to always send "website".
registerPlugin({ ...websitePlugin, name: "websites" });
registerPlugin(googleMapsPlugin);
registerPlugin(instagramPlugin);
// ⚠️ ALIAS FIX: same pattern as "websites" above. Jobs are arriving with
// source "instagram_biz" (matches the instagram_biz cost key already
// present in credits.ts's BASE_SCRAPE_COSTS), but only "instagram" was
// ever registered here — causing every such job to fail with "No plugin
// registered for source 'instagram_biz'" and land in the DLQ. Registering
// the same plugin under both keys fixes this without touching the
// job-producing code. Remove once the root cause (wherever
// input_data.source is derived for Instagram jobs) is fixed to always
// send "instagram".
registerPlugin({ ...instagramPlugin, name: "instagram_biz" });
registerPlugin(linkedinPlugin);
registerPlugin(youtubePlugin);
registerPlugin(amazonPlugin);
registerPlugin(facebookPlugin);
registerPlugin(ebayPlugin);
registerPlugin(tripadvisorPlugin);
