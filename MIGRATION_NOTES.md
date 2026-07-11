# Migration Notes — Plugin → Provider Router refactor

This zip is a structural refactor of the existing worker, applying the
`Worker → Plugin → Provider Interface → Provider → API` pattern to all 9
plugins. **No business logic was rewritten** — every vendor call, parser,
normalizer, and validator does exactly what it did before. What changed is
*where* the vendor-calling code lives and *how* a plugin reaches it.

## What's new (scraper-core)

- **`provider.ts`** — `SourceProvider` interface + `ProviderRouter` class.
  A router tries providers in capability-registry order, skips any whose
  circuit breaker is OPEN, falls back to the next provider on failure, and
  records metrics. Every plugin now talks to a router, never to a vendor
  SDK/fetch call directly.
- **`metrics.ts`** — per-provider latency/success-rate tracking in Redis
  (hourly buckets), separate from the circuit breaker. Read it with
  `getProviderMetrics(providerName, redis)` — this is what a future
  admin dashboard should read from.
- **`capabilityRegistry.ts`** — the ordered provider list per capability
  (`google_maps`, `website`, `linkedin`, ...). Defaults are hardcoded but
  overridable at runtime via the `CAPABILITY_REGISTRY_JSON` env var
  (JSON, shallow-merged over the defaults) — useful for an emergency
  provider swap without a redeploy.

## Per-plugin change (same shape for all 9)

```
plugins/<name>/
    index.ts          orchestration only (access check, cache, save, charge,
                       enrichment dispatch) — imports the router, never a vendor
    router.ts          new — wires capabilityRegistry's provider list into a
                        ProviderRouter for this plugin
    providers/
        <vendor>.ts     the old serpapi.ts / apify.ts / inline fetch function,
                         moved here, implementing SourceProvider
    normalizer.ts / parser.ts / validator.ts   — untouched
```

Amazon, eBay, Facebook, Instagram (keyword-search path), LinkedIn, Tripadvisor
and Google Maps got a straightforward move: one vendor call → one provider.

Website and YouTube each have one internally-multi-level provider
(`website-hybrid-crawler`, `youtube-about-page-scraper`) rather than being
split further — see the comment at the top of each `providers/*.ts` file for
why. Splitting those further is a reasonable next step but needs test
coverage this pass didn't have.

## Bugs fixed as a side effect of centralizing circuit-breaker logic

Each provider used to check/record its own circuit breaker state under an
inconsistent key:

| Plugin | Old breaker key | Problem |
|---|---|---|
| Amazon | `"amazon"` (plugin name) | would collide with a 2nd Amazon provider |
| Tripadvisor | `"serpapi"` (generic vendor name) | would collide with *any other* SerpApi-based plugin |
| LinkedIn | `"apify"` (generic vendor name) | would collide with any other Apify-based plugin |
| Google Maps, eBay, Facebook | already provider-scoped | no bug |

All circuit-breaker state is now keyed by `provider.name` (e.g.
`"amazon-serpapi"`, `"tripadvisor-serpapi"`, `"linkedin-apify"`), owned by
the router, not duplicated inside each provider file.

## Also fixed

- `google-maps/index.ts`'s docstring claimed a "Playwright Fallback" that
  didn't exist in the code (already removed, comment was stale) — corrected.
- Removed all `dist/` folders (stale compiled output referencing the old
  function names) — **run `npm install && npm run build` in each package/
  plugin before deploying**, they aren't included in this zip.

## What was intentionally NOT done in this pass

- No generic `runScrapePlugin()` orchestration wrapper — the identical
  access-check/cache/save/charge/dispatch block still repeats per plugin.
  Worth doing next; skipped here to keep this refactor's blast radius to
  "the provider layer" only.
- No Pipeline Orchestrator (stage-based resume) — separate, larger piece of
  work requiring its own persistence design.
- Instagram's Playwright profile-URL fallback and Website's 3-level
  fetch→Playwright→Playwright+proxy escalation were not split into multiple
  providers — see the in-file comments for why.

## Verification done

Every `.ts` file under `src/packages/scraper-core` and `src/plugins` was
run through `esbuild` as a syntax check (catches malformed TS/JS). This is
**not** a full type-check or a test run — please run your normal
`npm run build` / CI in each workspace package before deploying.
