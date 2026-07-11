# CompX Worker — Roadmap Migration Status

## কোথায় রাখবেন
আপনার repo তে `worker/` folder এর *পাশে* (sibling হিসেবে) এই তিনটা বসান:
```
your-repo/
  worker/              ← existing, অপরিবর্তিত (legacy fallback হিসেবে থাকবে)
  packages/
    scraper-core/       ← নতুন
  plugins/
    website/            ← নতুন
  workers/
    registry/           ← নতুন
```

## ✅ এই ধাপে যা সম্পূর্ণ হয়েছে

**Phase 1 — Scraper Core**
- `browser/browser-manager.ts` — discoverScrapeJob.js এর `launchBrowser()` থেকে extract, platform-agnostic
- `proxy/proxy-manager.ts` + `proxy/routing-engine.ts` — proxy.js + scrapingBrain.js + routingEngine.js একত্র, **bug fix সহ**
- `parser/domain.ts`, `parser/email.ts` — dispatcher.js + pipelineSave.js + verifyEmailJob.js এর duplicate normalize/pattern logic একত্র
- `validation/validator.ts` — Phase 13, save-এর আগে reusable validation gate
- `storage/uploader.ts` — pipelineSave.js generalize, প্রতি source এর হার্ডকোড if/else সরিয়ে injectable `RowMapper`
- `utils/logger.ts` — hiringSignalsJob.js এর buffered logger pattern generalize
- `crawler/crawler-factory.ts` — Phase 4, browser ছাড়াই lightweight fetch+parse

**Phase 9 — Browser Pool (নতুন capability, আগে ছিল না)**
- `browser/browser-pool.ts` — fixed-size Chromium pool, context reuse, RAM cap

**Phase 3 — Plugin Registry**
- `workers/registry/plugin-contract.ts` — `SourcePlugin` interface
- `workers/registry/registry.ts` — registration map, legacy fallback built in

**Phase 4 — Website Worker (প্রথম plugin, পুরোপুরি migrate করা)**
- `plugins/website/index.ts` — URL → crawl → extract → validate → save, scraper-core দিয়ে

## 🐛 Review-এ পাওয়া বাগ, এই migration-এ ঠিক হয়েছে

1. **`lib/scrapingBrain.js` vs `lib/proxy.js` field mismatch** — risk engine `proxyScoreThreshold` রিটার্ন করত, proxy selector `routing.minScore` পড়ত। কখনো মেলেনি — proxy min-score filter silently কাজ করত না। এখন `routing-engine.ts` সবসময় `minScore` দেয়, `proxy-manager.ts` তাই পড়ে।
2. **`lib/routingEngine.js` dead code ছিল** — সঠিক field name (`minScore`) থাকা সত্ত্বেও কোথাও import হয়নি। নতুন `routing-engine.ts`-ই একমাত্র version।
3. **দুইটা আলাদা domain-normalize function** (`dispatcher.js::normalizeDomain` বনাম `pipelineSave.js::normalizeWebsite`) — edge case-এ ভিন্ন আচরণ করত (social URL reject করা vs না করা)। এখন একটাই `parser/domain.ts`।

## ⏳ পরবর্তী ধাপ (আপনার অনুমোদন সাপেক্ষে, একটা একটা করে)

| Phase | কাজ | Risk |
|---|---|---|
| Dispatcher wiring | `DISPATCHER_INTEGRATION.md` অনুযায়ী `dispatcher.js`-এ ৫ লাইন যোগ | কম — fallback আছে |
| Phase 5 | Google Maps plugin migrate (discoverScrapeJob.js থেকে বের করা, browser-pool ব্যবহার করে) | মাঝারি — Puppeteer/Playwright + infinite scroll logic জটিল |
| Phase 6 | Instagram plugin migrate + Session Pool (Phase 10) | বেশি — login/session state আছে |
| Phase 7 | LinkedIn plugin — Instagram-এর structure অনুসরণ | বেশি |
| Phase 8 | YouTube plugin (cheerio→puppeteer fallback pattern) | মাঝারি |
| — | Amazon plugin (roadmap-এ নেই কিন্তু কোডে আছে) | মাঝারি |
| Phase 14 | AI Enrichment queue | নতুন কাজ |
| Phase 15/16 | Redis cache + background pre-scrape scheduler | নতুন কাজ |

**সবচেয়ে ঝুঁকিপূর্ণ পরের ধাপ Google Maps ও Instagram** — এই দুটোতে discoverScrapeJob.js-এর সবচেয়ে বেশি platform-specific লাইন আছে (session, infinite scroll, anti-detection)। আমি recommend করব Google Maps দিয়ে পরের turn শুরু করতে, কারণ এটাতে Instagram-এর মতো persistent login session নেই — তুলনামূলক সহজ, এবং browser-pool.ts কে প্রথমবার real traffic-এ test করার সুযোগ দেবে।

## যা এখনো করা হয়নি (ইচ্ছাকৃতভাবে)
- Google Maps / LinkedIn / Instagram / YouTube / Amazon plugin migration — এখনো legacy `discoverScrapeJob.js`-এ, registry miss হলে সেখানেই পড়বে
- Session Pool (Phase 10) — Instagram/LinkedIn migration এর সাথেই করা ভালো, আগে থেকে বানালে unused abstraction হয়ে যাবে
- `dripJob.js`/`webhookJob.js`/`hiringSignalsJob.js` — এগুলো আপনার কোডেই "startup mode এ disabled", roadmap-এর অংশ না, তাই ছুঁইনি
