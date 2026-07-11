/**
 * scraper-core/browser/browser-manager.ts
 *
 * Extracted from worker/jobs/discoverScrapeJob.js::launchBrowser().
 * No platform-specific (Instagram/LinkedIn) logic here — that stays in plugins.
 *
 * IMPORTANT: this module only creates *contexts*. Actual browser process
 * reuse happens in browser-pool.ts (Phase 9) — plugins should get contexts
 * from the pool, not call launchContext() directly, unless doing a true
 * one-off scrape outside the pool's lifecycle.
 */

import type { Browser, BrowserContext } from "playwright";

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

export interface LaunchOptions {
  proxy?: ProxyConfig | null;
  blockMedia?: boolean; // default true — mirrors the original's image/font/media blocking
  userAgent?: string;
}

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const DEFAULT_LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-blink-features=AutomationControlled",
];

/** Launches a raw Chromium process. Prefer BrowserPool.acquire() over calling this directly. */
export async function launchChromium(): Promise<Browser> {
  const { chromium } = await import("playwright");
  return chromium.launch({ headless: true, args: DEFAULT_LAUNCH_ARGS });
}

/** Creates a fresh context on an existing (pooled) browser — this is the reusable unit per job. */
export async function createContext(
  browser: Browser,
  opts: LaunchOptions = {}
): Promise<BrowserContext> {
  const context = await browser.newContext({
    userAgent: opts.userAgent || DEFAULT_UA,
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    timezoneId: "America/New_York",
    permissions: [],
    colorScheme: "light",
    javaScriptEnabled: true,
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
  });

  if (opts.blockMedia !== false) {
    await context.route(
      "**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,mp4,mp3}",
      (route) => route.abort()
    );
  }

  return context;
}

/**
 * One-off browser+context, for callers that genuinely need a standalone
 * instance outside the pool (rare — e.g. long-lived session workers).
 * Caller is responsible for closing both.
 */
export async function launchStandalone(
  opts: LaunchOptions = {}
): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await launchChromium();
  const context = await createContext(browser, opts);
  return { browser, context };
}
