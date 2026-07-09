# Dispatcher Integration — tested build, registry-first routing

`worker-patched/dispatcher.js` and `worker-patched/index.js` are **complete,
tested drop-in replacements** for `worker/jobs/dispatcher.js` and
`worker/src/index.js`. Copy them over the originals (or diff them in) —
everything else in this migration (scraper-core, plugins, registry,
ai-enrichment, scheduler) is already wired in and builds cleanly
(`./build.sh` was run end-to-end with zero TypeScript errors before this zip
was produced).

## 1. Folder placement

```
your-repo/
  worker/                  ← existing, now imports from the packages below
  packages/scraper-core/    ← new
  plugins/                  ← new (website, google-maps, instagram, linkedin, youtube, amazon)
  workers/                  ← new (registry, ai-enrichment, scheduler)
  package.json               ← new — root, npm workspaces
  tsconfig.base.json          ← new
  build.sh                    ← new
```

## 2. Add `worker/` to the workspaces

The root `package.json` in this zip lists `packages/*`, `plugins/*`,
`workers/*` as workspaces. **Add `worker` to that array too** so its
`npm install` resolves `@compx/scraper-core`, `@compx/worker-registry`, etc.
as proper symlinked packages:

```json
{
  "workspaces": ["worker", "packages/*", "plugins/*", "workers/*"]
}
```

Then from the repo root:

```bash
npm install
./build.sh
```

`build.sh` builds in the required dependency order (scraper-core → plugins →
workers) — plain `npm run build --workspaces` does NOT guarantee this order,
so use the script (or wire it into your CI in the same order).

## 3. Apply the patched files

```bash
cp worker-patched/dispatcher.js worker/jobs/dispatcher.js
cp worker-patched/index.js       worker/src/index.js
```

Both are fallback-safe: `getPlugin(source)` returns `undefined` for any
source not in the registry (there shouldn't be any left — website,
google_maps, instagram, linkedin, youtube, amazon are all registered — but
if you add a 7th source later without registering it yet, it'll cleanly
fall through to `discoverScrapeJob.js`).

## 4. Run the SQL migration

`MIGRATIONS.sql` adds the tables/columns the new features need
(`scraper_sessions` for Phase 10, `leads_verified` AI columns for Phase 14,
`search_log` + `get_popular_searches()` for Phase 16). Run it against
Supabase before deploying.

## 5. Environment variables (new, on top of existing ones)

```
ANTHROPIC_API_KEY=       # Phase 14 AI enrichment — falls back to a heuristic score if unset
BROWSER_POOL_SIZE=4      # Phase 9 — Chromium processes kept warm (roadmap's "Chrome 1-4" example)
```

## 6. Provisioning Instagram/LinkedIn sessions (Phase 10)

Session rows don't exist until you bootstrap them. Run once per account,
in a **headed** browser the first time (checkpoints/2FA need a human):

```ts
import { chromium } from "playwright";
import { loginAndStoreSession } from "@compx/plugin-instagram/dist/login.js";
// or: from "@compx/plugin-linkedin/dist/login.js"

const browser = await chromium.launch({ headless: false });
await loginAndStoreSession(browser, "Session A", "username", "password");
await browser.close();
```

Repeat with different accounts for "Session B", "Session C", "Session D" —
the roadmap's own naming — to build the rotating pool.

## Why fallback-on-miss, not fail-on-miss

Even though all six sources are registered, keeping the legacy fallback in
place costs nothing and means any future source you add is a same-day,
independent, low-risk deploy — register the plugin, ship it — with no
big-bang cutover risk.

