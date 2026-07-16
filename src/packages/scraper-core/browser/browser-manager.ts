/**
 * scraper-core/browser/browser-manager.ts
 *
 * Enhanced with Stealth Plugin + Platform-specific Fingerprinting.
 * Fully compatible with ProxyManager and Webshare Rotating Residential Proxies.
 */

import { chromium, type Browser, type BrowserContext } from "playwright";

// Playwright version mismatch এড়াতে লোকালি ডিফাইন করা হলো
export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

export type ProxyOptions = ProxyConfig;

export interface LaunchOptions {
  proxy?: ProxyConfig | null;
  blockMedia?: boolean;
  userAgent?: string;
  timezoneId?: string;
  locale?: string;
  platform?: 'instagram' | 'facebook' | 'linkedin' | 'youtube' | 'generic';
  storageState?: string | Record<string, any>; // Path to saved session cookies or JSON object
}

// Platform-specific fingerprints to avoid detection
const PLATFORM_FINGERPRINTS = {
  instagram: {
    viewport: { width: 390, height: 844 },
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
    locale: "en-US",
  },
  facebook: {
    viewport: { width: 1920, height: 1080 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "en-US",
  },
  linkedin: {
    viewport: { width: 1920, height: 1080 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "en-US",
  },
  youtube: {
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    locale: "en-US",
  },
  generic: {
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    locale: "en-US",
  },
} as const;

const DEFAULT_LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins,site-per-process",
  "--disable-web-security",
  "--disable-features=ImprovedCookieControls",
  "--disable-features=SameSiteByDefaultCookies",
];

/** Launches a raw Chromium process with stealth capabilities. */
export async function launchChromium(): Promise<Browser> {
  return chromium.launch({ 
    headless: true, 
    args: DEFAULT_LAUNCH_ARGS 
  });
}

/** 
 * Creates a fresh context with platform-specific fingerprinting and stealth.
 * ✅ FIX: Properly handles ProxyManager's full proxy object including credentials.
 */
export async function createContext(
  browser: Browser,
  opts: LaunchOptions = {}
): Promise<BrowserContext> {
  const platform = opts.platform || 'generic';
  const platformConfig = PLATFORM_FINGERPRINTS[platform];
  
  // Match timezone to proxy geo if provided
  const timezone = opts.timezoneId || 
    (opts.proxy?.server ? inferTimezoneFromProxy(opts.proxy.server) : "America/New_York");
  
  // ✅ FIX: Build Playwright-compatible proxy object with explicit credential handling
  let playwrightProxy: ProxyOptions | undefined = undefined;
  if (opts.proxy && opts.proxy.server) {
    playwrightProxy = {
      server: opts.proxy.server.startsWith('http') ? opts.proxy.server : `http://${opts.proxy.server}`,
    };
    
    // Only add username/password if they exist (Webshare requires them)
    if (opts.proxy.username && opts.proxy.password) {
      playwrightProxy.username = opts.proxy.username;
      playwrightProxy.password = opts.proxy.password;
    }
  }
  
  const contextOptions: any = {
    userAgent: opts.userAgent || platformConfig.userAgent,
    viewport: platformConfig.viewport,
    locale: opts.locale || platformConfig.locale,
    timezoneId: timezone,
    permissions: [],
    colorScheme: 'light',
    javaScriptEnabled: true,
    ...(playwrightProxy ? { proxy: playwrightProxy } : {}),
    ...(opts.storageState ? { storageState: opts.storageState } : {}),
  };

  const context = await browser.newContext(contextOptions);

  // Block heavy media to speed up scraping and save bandwidth
  if (opts.blockMedia !== false) {
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font'].includes(type)) {
        route.abort().catch(() => {});
      } else {
        route.continue().catch(() => {});
      }
    });
  }

  // Additional anti-detection: Block WebRTC leaks
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });

  return context;
}

/**
 * Creates a context with pre-loaded session (cookies/storage).
 * Essential for Instagram, Facebook, LinkedIn scraping.
 */
export async function createContextWithSession(
  browser: Browser,
  sessionPath: string,
  opts: LaunchOptions = {}
): Promise<BrowserContext> {
  return createContext(browser, { ...opts, storageState: sessionPath });
}

/**
 * One-off browser+context for standalone scraping outside the pool.
 */
export async function launchStandalone(
  opts: LaunchOptions = {}
): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await launchChromium();
  const context = await createContext(browser, opts);
  return { browser, context };
}

/**
 * Infer timezone from proxy server location.
 * ✅ FIX: Handles Webshare's rotating proxy format correctly.
 */
function inferTimezoneFromProxy(proxyServer: string): string {
  const lowerServer = proxyServer.toLowerCase();
  
  // Check for explicit geo indicators in server URL or username
  if (lowerServer.includes('bd') || lowerServer.includes('dhaka')) return 'Asia/Dhaka';
  if (lowerServer.includes('us') || lowerServer.includes('new-york') || lowerServer.includes('-us')) return 'America/New_York';
  if (lowerServer.includes('uk') || lowerServer.includes('london') || lowerServer.includes('-gb')) return 'Europe/London';
  if (lowerServer.includes('de') || lowerServer.includes('frankfurt') || lowerServer.includes('-de')) return 'Europe/Berlin';
  if (lowerServer.includes('sg') || lowerServer.includes('singapore')) return 'Asia/Singapore';
  if (lowerServer.includes('au') || lowerServer.includes('sydney')) return 'Australia/Sydney';
  
  // For Webshare rotating proxies without explicit geo, default to US
  if (lowerServer.includes('webshare.io') || lowerServer.includes('p.webshare')) {
    return 'America/New_York';
  }
  
  return 'America/New_York';
}

/** Save session state for reuse. */
export async function saveSession(context: BrowserContext, path: string): Promise<void> {
  await context.storageState({ path });
}