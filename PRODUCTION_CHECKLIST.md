# Production Readiness Checklist — read before release

Everything below was built, and the full TypeScript tree
(scraper-core + 6 plugins + 3 workers) **compiles cleanly end-to-end**
(`./build.sh` was run in this environment with 0 errors right before
packaging). That verifies wiring and types — it does NOT verify live
behavior against real Instagram/LinkedIn/Google Maps pages, since this
sandbox has no proxies, no Instagram/LinkedIn accounts, no Redis, and no
Supabase project to run against.

## Must-do before flipping real traffic to it

1. **Run `MIGRATIONS.sql`** against your actual Supabase project.
2. **Add `worker` to the root `workspaces` array** and `npm install` from
   the repo root so `@compx/*` packages resolve (see `DISPATCHER_INTEGRATION.md`).
3. **Provision at least one session per platform** (Instagram, LinkedIn) —
   see `DISPATCHER_INTEGRATION.md` §6. Without this, `instagram`/`linkedin`
   jobs will return `{ error: "no_session_available" }` immediately, not fail silently.
4. **Set `ANTHROPIC_API_KEY`** or accept the heuristic lead-score fallback for Phase 14.
5. **Test each plugin against ONE real target first**, at low volume, before
   pointing production traffic at it:
   - `website` and `amazon` — lowest risk, no login, no session.
   - `google_maps` — no login, but DOM selectors (`RESULTS_PANEL_SELECTOR`,
     `CARD_SELECTOR` in `plugins/google-maps/index.ts`) may need adjusting —
     Google changes Maps' DOM periodically without notice.
   - `instagram` / `linkedin` — highest risk (ToS + selector-drift +
     account-ban). Run against 2-3 profiles manually and watch the logs
     before any real batch job.
   - `youtube` — the fetch-based path depends on `ytInitialData` still
     being embedded in the About page HTML; the browser fallback exists
     precisely because that can silently stop working.

## Known limitations, stated plainly

- **Selectors will drift.** Every browser-based plugin (`google-maps`,
  `instagram`, `linkedin`, `youtube`'s fallback) scrapes live DOM structure
  that the platforms change without notice. This isn't a bug to "fix once" —
  it's ongoing maintenance inherent to scraping, same as your original
  `discoverScrapeJob.js` had.
- **Instagram/LinkedIn login-based scraping risks account bans and violates
  those platforms' Terms of Service.** This was already true of your
  original `instagram/login.ts`-style code; this migration continues the
  same approach (now with session rotation, which reduces but doesn't
  eliminate ban risk) rather than introducing new risk.
- **The Amazon plugin's HTML parsing (`plugins/amazon/index.ts`) uses a
  regex-based card extractor**, not a proper DOM parser — Amazon's search
  result markup is dense and regex is brittle here. If Amazon volume matters
  to your business, this is the first thing worth swapping for a real
  browser-pool-based extraction (same pattern as google-maps).
- **No automated tests were written** (no Instagram/LinkedIn test accounts
  or live Supabase project were available in this environment to test
  against). Add integration tests against a staging Supabase project before
  relying on this in production.

## What IS solid and needs no further work

- Type-checked, cleanly-building module graph (scraper-core ← plugins ← registry)
- Browser pool (Phase 9), session pool (Phase 10) — structurally sound,
  generic, not tied to any one platform's quirks
- The 3 bugs fixed during migration (proxy score field mismatch, dead
  routing-engine code, duplicate domain normalizers) — these were real
  production bugs, now gone regardless of anything else
- Dispatcher/index.js fallback safety net — a config error or missing
  plugin registration degrades to old behavior, not a crash
