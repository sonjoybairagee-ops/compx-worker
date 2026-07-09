/**
 * workers/registry/plugin-contract.ts
 *
 * Every plugin under /plugins/<source>/ implements this. The dispatcher
 * never needs to know Instagram from YouTube from a new Phase-15-style
 * source — it just calls plugin.run(ctx). Adding a new source (Facebook
 * Pages, TikTok, X, Crunchbase, Yelp — the roadmap's own examples) means
 * writing one new folder under /plugins that satisfies this interface and
 * registering it below. Nothing in scraper-core, the queue, the dispatcher,
 * or the browser pool needs to change.
 */
export {};
