/**
 * workers/registry/registry.ts
 *
 * Phase 3 from the roadmap. Central plugin registration hub.
 * Fully adapted for Supabase + Playwright architecture.
 */

import type { SourcePlugin } from "@compx/scraper-core";
export type { SourcePlugin, PluginContext, PluginResult } from "@compx/scraper-core";

// Import all migrated plugins
import { websitePlugin } from "@compx/plugin-website";
import { googleMapsPlugin } from "@compx/plugin-google-maps";
import { instagramPlugin } from "@compx/plugin-instagram";
import { linkedinPlugin } from "@compx/plugin-linkedin"; // ✅ Now uses Playwright, not Apify
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

// Website Scraper (No Browser)
registerPlugin(websitePlugin);

// ✅ ALIAS FIX: Legacy jobs send "websites", plugin expects "website"
registerPlugin({ ...websitePlugin, name: "websites" });

// Google Maps (Browser Pool)
registerPlugin(googleMapsPlugin);

// Instagram (Browser Pool + Session Manager)
registerPlugin(instagramPlugin);

// ✅ ALIAS FIX: Legacy jobs send "instagram_biz", plugin expects "instagram"
registerPlugin({ ...instagramPlugin, name: "instagram_biz" });

// LinkedIn (✅ UPDATED: Now uses Playwright + Session Manager, requiresBrowser: true)
registerPlugin(linkedinPlugin);

// YouTube (Fetch First, Browser Fallback)
registerPlugin(youtubePlugin);

// Amazon (No Browser / SerpApi)
registerPlugin(amazonPlugin);

// Facebook (Browser Pool + Session Manager)
registerPlugin(facebookPlugin);

// eBay (SerpApi)
registerPlugin(ebayPlugin);

// TripAdvisor (SerpApi)
registerPlugin(tripadvisorPlugin);

console.log(`[Registry] Registered ${registry.size} plugins: ${listPlugins().join(", ")}`);