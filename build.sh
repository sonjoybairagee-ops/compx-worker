#!/usr/bin/env bash
# Build order matters — dependents need their dependency's dist/*.d.ts already built.
set -e
echo "1/3 — scraper-core"
(cd packages/scraper-core && npx tsc -p tsconfig.json)

echo "2/3 — plugins (all depend only on scraper-core)"
for p in website google-maps instagram linkedin youtube amazon; do
  (cd "plugins/$p" && npx tsc -p tsconfig.json)
done

echo "3/3 — workers (registry depends on plugins; ai-enrichment/scheduler are independent)"
for w in registry ai-enrichment scheduler; do
  (cd "workers/$w" && npx tsc -p tsconfig.json)
done

echo "✅ Build complete."
