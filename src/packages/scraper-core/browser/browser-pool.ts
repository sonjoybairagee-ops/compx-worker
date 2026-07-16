/**
 * scraper-core/browser/browser-pool.ts
 *
 * Phase 9 from the roadmap: "একটা browser প্রতি job-এ launch করবে না।"
 *
 * This did NOT exist in the old codebase — discoverScrapeJob.js's
 * launchBrowser() spun up a brand new Chromium process per call. This pool
 * keeps a fixed number of Chromium processes alive and hands out fresh
 * *contexts* (cheap) instead of fresh *browsers* (expensive) per job.
 *
 * Usage:
 *   const pool = getBrowserPool();
 *   const lease = await pool.acquireContext({ proxy, platform: 'instagram' });
 *   try {
 *     const page = await lease.context.newPage();
 *     ...
 *   } finally {
 *     await lease.release(); // closes the context, returns the browser slot to the pool
 *   }
 */

import type { Browser, BrowserContext } from "playwright";
import { launchChromium, createContext, type LaunchOptions } from "./browser-manager.js";

interface PoolSlot {
  browser: Browser;
  inUseContexts: number;
  launchedAt: number;
}

export interface ContextLease {
  context: BrowserContext;
  release: () => Promise<void>;
}

export interface BrowserPoolOptions {
  /** Max concurrent Chromium processes. Roadmap example: 4 (Chrome 1-4). */
  size?: number;
  /** Recycle a browser process after this many contexts, to bound memory creep. */
  maxContextsPerBrowser?: number;
  /** Recycle a browser process after this long, regardless of usage. */
  maxBrowserAgeMs?: number;
}

const DEFAULTS: Required<BrowserPoolOptions> = {
  size: parseInt(process.env.BROWSER_POOL_SIZE || "4", 10),
  maxContextsPerBrowser: 50,
  maxBrowserAgeMs: 30 * 60_000, // 30 min
};

export class BrowserPool {
  private slots: PoolSlot[] = [];
  private opts: Required<BrowserPoolOptions>;
  private waiters: Array<() => void> = [];
  private contextsServed = new WeakMap<Browser, number>();

  constructor(opts: BrowserPoolOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  private async getOrLaunchSlot(): Promise<PoolSlot> {
    // FIX: previously this returned the FIRST non-stale slot found, where
    // "stale" only considered cumulative contexts served / age — never
    // current concurrent load (inUseContexts). That meant every call
    // piled onto slot 0 (since it's essentially never "stale" until it's
    // served 50 contexts total) and the pool never actually launched a
    // 2nd/3rd/4th browser under concurrent load, even with
    // BROWSER_POOL_SIZE=4 — defeating the entire point of a pool sized
    // for concurrency and creating heavy contention on one Chromium
    // process instead.
    //
    // New behavior: launch a fresh browser (up to `size`) before reusing
    // an existing one, so concurrent load actually spreads across the
    // full pool. Once at capacity, pick the least-loaded non-stale slot
    // rather than always the first.
    const usable = this.slots.filter((slot) => {
      const served = this.contextsServed.get(slot.browser) || 0;
      const stale =
        served >= this.opts.maxContextsPerBrowser ||
        Date.now() - slot.launchedAt > this.opts.maxBrowserAgeMs;
      return !stale;
    });

    if (usable.length < this.opts.size) {
      const browser = await launchChromium();
      const slot: PoolSlot = { browser, inUseContexts: 0, launchedAt: Date.now() };
      this.slots.push(slot);
      this.contextsServed.set(browser, 0);
      return slot;
    }

    if (usable.length > 0) {
      // Least-loaded first so concurrent contexts spread evenly instead
      // of stacking on whichever slot happened to be first in the array.
      usable.sort((a, b) => a.inUseContexts - b.inUseContexts);
      return usable[0];
    }

    // Pool is full and every slot is either busy-but-fresh or stale-and-recycling.
    // Wait for a release, then retry.
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return this.getOrLaunchSlot();
  }

  private async recycleIfNeeded(slot: PoolSlot) {
    const served = this.contextsServed.get(slot.browser) || 0;
    const stale =
      slot.inUseContexts === 0 &&
      (served >= this.opts.maxContextsPerBrowser ||
        Date.now() - slot.launchedAt > this.opts.maxBrowserAgeMs);

    if (stale) {
      // ✅ FIX: Added observability log to track browser recycling in production
      console.log(`[BrowserPool] ♻️ Recycling browser (Served: ${served}, Age: ${Math.round((Date.now() - slot.launchedAt) / 1000)}s)`);
      
      this.slots = this.slots.filter((s) => s !== slot);
      try {
        await slot.browser.close();
      } catch {
        /* already dead */
      }
    }
  }

  async acquireContext(launchOpts: LaunchOptions = {}): Promise<ContextLease> {
    const resolvedOpts: LaunchOptions = {
      ...launchOpts,
      proxy:
        launchOpts.proxy !== undefined
          ? launchOpts.proxy
          : process.env.PROXY_SERVER
          ? {
              server: process.env.PROXY_SERVER,
              username: process.env.PROXY_USERNAME,
              password: process.env.PROXY_PASSWORD,
            }
          : undefined,
    };
    
    const slot = await this.getOrLaunchSlot();
    slot.inUseContexts++;
    this.contextsServed.set(slot.browser, (this.contextsServed.get(slot.browser) || 0) + 1);

    // This seamlessly passes 'platform', 'storageState', etc. to browser-manager.ts
    const context = await createContext(slot.browser, resolvedOpts);

    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      try {
        await context.close();
      } catch {
        /* ignore */
      }
      slot.inUseContexts--;
      await this.recycleIfNeeded(slot);
      const waiter = this.waiters.shift();
      if (waiter) waiter();
    };

    return { context, release };
  }

  stats() {
    return {
      browsers: this.slots.length,
      maxBrowsers: this.opts.size,
      inUseContexts: this.slots.reduce((sum, s) => sum + s.inUseContexts, 0),
    };
  }

  async shutdown() {
    await Promise.all(this.slots.map((s) => s.browser.close().catch(() => {})));
    this.slots = [];
  }
}

// ── Singleton — one pool per worker process ───────────────────────────────────
let sharedPool: BrowserPool | null = null;

export function getBrowserPool(opts?: BrowserPoolOptions): BrowserPool {
  if (!sharedPool) sharedPool = new BrowserPool(opts);
  return sharedPool;
}