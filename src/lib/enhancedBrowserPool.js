/**
 * Enhanced Browser Pool
 * Optimized browser instance management for high-performance scraping
 */

import puppeteer from 'puppeteer';
import { WORKER_CONFIG } from '../config/workerConfig.js';

class EnhancedBrowserPool {
  constructor() {
    this.browsers = new Map(); // browserID => { browser, contexts, lastUsed, pages }
    this.stats = {
      created: 0,
      reused: 0,
      closed: 0,
      pages: 0,
      errors: 0,
    };
    this.isWarming = false;
    this.cleanupInterval = null;
  }

  async initialize() {
    console.log('[BrowserPool] Initializing enhanced browser pool...');
    
    // Start cleanup timer
    this.cleanupInterval = setInterval(() => {
      this.cleanupIdleBrowsers();
    }, 60000); // Check every minute

    // Warmup if configured
    if (WORKER_CONFIG.BROWSER_POOL.WARMUP_ON_START) {
      await this.warmup();
    }

    console.log('[BrowserPool] ✅ Pool initialized');
  }

  /**
   * Pre-warm browser pool
   */
  async warmup() {
    if (this.isWarming) return;
    this.isWarming = true;

    console.log(`[BrowserPool] Warming up ${WORKER_CONFIG.BROWSER_POOL.MIN_INSTANCES} browsers...`);
    
    const promises = [];
    for (let i = 0; i < WORKER_CONFIG.BROWSER_POOL.MIN_INSTANCES; i++) {
      promises.push(this.createBrowser().catch(err => {
        console.error(`[BrowserPool] Warmup browser ${i} failed:`, err.message);
      }));
    }

    await Promise.allSettled(promises);
    this.isWarming = false;
    console.log(`[BrowserPool] ✅ Warmed up ${this.browsers.size} browsers`);
  }

  /**
   * Create a new browser instance
   */
  async createBrowser() {
    const browserID = `browser_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      const browser = await puppeteer.launch({
        headless: WORKER_CONFIG.BROWSER_POOL.HEADLESS,
        args: WORKER_CONFIG.BROWSER_POOL.ARGS,
        timeout: 30000,
      });

      const browserData = {
        browser,
        contexts: [],
        pages: 0,
        lastUsed: Date.now(),
        created: Date.now(),
      };

      this.browsers.set(browserID, browserData);
      this.stats.created++;

      console.log(`[BrowserPool] Created browser ${browserID} (total: ${this.browsers.size})`);
      return browserID;
    } catch (error) {
      this.stats.errors++;
      console.error('[BrowserPool] Failed to create browser:', error.message);
      throw error;
    }
  }

  /**
   * Get an available browser (create if needed)
   */
  async getBrowser() {
    // Try to reuse existing browser
    let selectedID = null;
    let lowestPages = Infinity;

    for (const [browserID, data] of this.browsers.entries()) {
      if (data.pages < WORKER_CONFIG.BROWSER_POOL.MAX_PAGES_PER_BROWSER) {
        if (data.pages < lowestPages) {
          lowestPages = data.pages;
          selectedID = browserID;
        }
      }
    }

    // Reuse existing browser
    if (selectedID) {
      const data = this.browsers.get(selectedID);
      data.lastUsed = Date.now();
      data.pages++;
      this.stats.reused++;
      return { browserID: selectedID, browser: data.browser };
    }

    // Create new browser if under limit
    if (this.browsers.size < WORKER_CONFIG.BROWSER_POOL.MAX_INSTANCES) {
      const browserID = await this.createBrowser();
      const data = this.browsers.get(browserID);
      data.pages++;
      return { browserID, browser: data.browser };
    }

    // Wait and retry if at max capacity
    console.warn('[BrowserPool] Pool at max capacity, waiting...');
    await new Promise(resolve => setTimeout(resolve, 2000));
    return this.getBrowser(); // Retry
  }

  /**
   * Release a page (decrement count)
   */
  releasePage(browserID) {
    const data = this.browsers.get(browserID);
    if (data) {
      data.pages = Math.max(0, data.pages - 1);
      data.lastUsed = Date.now();
    }
  }

  /**
   * Get a new page from browser pool
   */
  async getPage(options = {}) {
    const { browserID, browser } = await this.getBrowser();

    try {
      const page = await browser.newPage();
      
      // Set default timeout
      page.setDefaultTimeout(WORKER_CONFIG.BROWSER_POOL.PAGE_TIMEOUT_MS);

      // Set viewport
      await page.setViewport({ width: 1920, height: 1080 });

      // Set user agent
      await page.setUserAgent(
        options.userAgent || 
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      // Block unnecessary resources for faster loading
      if (options.blockResources !== false) {
        await page.setRequestInterception(true);
        page.on('request', (request) => {
          const resourceType = request.resourceType();
          if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
            request.abort();
          } else {
            request.continue();
          }
        });
      }

      this.stats.pages++;

      // Return page with cleanup callback
      return {
        page,
        browserID,
        close: async () => {
          try {
            await page.close();
            this.releasePage(browserID);
          } catch (err) {
            console.error('[BrowserPool] Error closing page:', err.message);
          }
        }
      };
    } catch (error) {
      this.releasePage(browserID);
      this.stats.errors++;
      throw error;
    }
  }

  /**
   * Cleanup idle browsers
   */
  async cleanupIdleBrowsers() {
    const now = Date.now();
    const idleThreshold = WORKER_CONFIG.BROWSER_POOL.BROWSER_IDLE_TIMEOUT_MS;
    const minInstances = WORKER_CONFIG.BROWSER_POOL.MIN_INSTANCES;

    for (const [browserID, data] of this.browsers.entries()) {
      const isIdle = (now - data.lastUsed) > idleThreshold;
      const hasNoPages = data.pages === 0;
      const canRemove = this.browsers.size > minInstances;

      if (isIdle && hasNoPages && canRemove) {
        console.log(`[BrowserPool] Closing idle browser ${browserID}`);
        try {
          await data.browser.close();
          this.browsers.delete(browserID);
          this.stats.closed++;
        } catch (err) {
          console.error(`[BrowserPool] Error closing browser ${browserID}:`, err.message);
        }
      }
    }
  }

  /**
   * Get pool statistics
   */
  getStats() {
    const activeBrowsers = this.browsers.size;
    const activePages = Array.from(this.browsers.values()).reduce((sum, b) => sum + b.pages, 0);
    const avgPagesPerBrowser = activeBrowsers > 0 ? (activePages / activeBrowsers).toFixed(2) : 0;

    return {
      browsers: {
        active: activeBrowsers,
        max: WORKER_CONFIG.BROWSER_POOL.MAX_INSTANCES,
        utilization: `${((activeBrowsers / WORKER_CONFIG.BROWSER_POOL.MAX_INSTANCES) * 100).toFixed(1)}%`,
      },
      pages: {
        active: activePages,
        average: avgPagesPerBrowser,
        max: WORKER_CONFIG.BROWSER_POOL.MAX_PAGES_PER_BROWSER,
      },
      lifetime: {
        browsersCreated: this.stats.created,
        browsersReused: this.stats.reused,
        browsersClosed: this.stats.closed,
        pagesCreated: this.stats.pages,
        errors: this.stats.errors,
      },
      reuseRate: this.stats.created > 0 
        ? `${((this.stats.reused / (this.stats.created + this.stats.reused)) * 100).toFixed(1)}%`
        : '0%',
    };
  }

  /**
   * Log current stats
   */
  logStats() {
    const stats = this.getStats();
    console.log('\n[BrowserPool] Statistics:');
    console.log(`  Browsers: ${stats.browsers.active}/${stats.browsers.max} (${stats.browsers.utilization})`);
    console.log(`  Pages: ${stats.pages.active} active, ${stats.pages.average} avg/browser`);
    console.log(`  Reuse Rate: ${stats.reuseRate}`);
    console.log(`  Lifetime: ${stats.lifetime.browsersCreated} created, ${stats.lifetime.pagesCreated} pages`);
  }

  /**
   * Shutdown all browsers
   */
  async shutdown() {
    console.log('[BrowserPool] Shutting down browser pool...');
    
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    const closePromises = [];
    for (const [browserID, data] of this.browsers.entries()) {
      closePromises.push(
        data.browser.close().catch(err => {
          console.error(`[BrowserPool] Error closing browser ${browserID}:`, err.message);
        })
      );
    }

    await Promise.allSettled(closePromises);
    this.browsers.clear();

    console.log('[BrowserPool] ✅ All browsers closed');
  }
}

// Singleton instance
let poolInstance = null;

export function getBrowserPool() {
  if (!poolInstance) {
    poolInstance = new EnhancedBrowserPool();
  }
  return poolInstance;
}

export default EnhancedBrowserPool;
