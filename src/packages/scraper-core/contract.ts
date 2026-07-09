/**
 * scraper-core/contract.ts
 *
 * (Originally drafted under workers/registry/ — moved here so plugins can
 * import it via the "@compx/scraper-core" workspace package instead of a
 * relative path that reaches outside their own tsconfig rootDir. registry.ts
 * re-exports this for backwards compatibility.)
 *
 * Every plugin under /plugins/<source>/ implements this. The dispatcher
 * never needs to know Instagram from YouTube from a new Phase-15-style
 * source — it just calls plugin.run(ctx). Adding a new source (Facebook
 * Pages, TikTok, X, Crunchbase, Yelp — the roadmap's own examples) means
 * writing one new folder under /plugins that satisfies this interface and
 * registering it below. Nothing in scraper-core, the queue, the dispatcher,
 * or the browser pool needs to change.
 */

export interface PluginContext {
  userId: string;
  orgId: string | null;
  jobId: string;
  input: Record<string, any>;
  /** Report progress back to the dispatcher (drives enrichment_jobs.progress + Socket.IO). */
  updateProgress: (data: { processedCount?: number; totalCount?: number; [k: string]: any }) => Promise<void>;
  /** Enqueue a downstream enrichment task with SETNX deduplication handled by the worker */
  dispatchEnrichment?: (kind: "website" | "social" | "ai" | "tripadvisor_review" | "ebay_seller", payload: any) => Promise<void>;
  redis?: any;
}

export interface PluginResult {
  leads_found: number;
  saved: number;
  errors: number;
  emails?: string[];
  phones?: string[];
  [key: string]: any;
}

export interface SourcePlugin {
  /** Unique key matching the `source` value used across dispatcher.js's DISCOVER_SOURCES and pipelineSave.js's per-source blocks. */
  name: string;
  /** Does this plugin need a browser context (Google Maps, Instagram, LinkedIn) or is it HTTP-only (websites, some APIs)? Lets the dispatcher decide whether to reserve a browser-pool slot. */
  requiresBrowser: boolean;
  run: (ctx: PluginContext) => Promise<PluginResult>;
}
