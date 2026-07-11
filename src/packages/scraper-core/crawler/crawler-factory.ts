/**
 * scraper-core/crawler/crawler-factory.ts
 *
 * Phase 4's flow is "URL → CheerioCrawler → Extract → Normalize → Save" — no
 * browser needed for plain HTML sites. This gives plugins a lightweight
 * fetch+parse crawler so a website-only job never has to pay for a Chromium
 * context. Browser-requiring plugins (Google Maps, Instagram, LinkedIn) use
 * browser-pool.ts instead.
 */

export interface FetchPageResult {
  url: string;
  status: number;
  html: string;
  ok: boolean;
}

export interface CrawlOptions {
  timeoutMs?: number;
  userAgent?: string;
  proxyUrl?: string | null; // e.g. "http://user:pass@host:port" — passed to fetch's dispatcher if using undici ProxyAgent
}

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export async function fetchPage(url: string, opts: CrawlOptions = {}): Promise<FetchPageResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": opts.userAgent || DEFAULT_UA },
      signal: controller.signal,
    });
    const html = await res.text();
    return { url, status: res.status, html, ok: res.ok };
  } finally {
    clearTimeout(timer);
  }
}

/** Extracts <a href> links from raw HTML, resolved against a base URL, deduped. No cheerio dependency — a plain regex pass is enough for link discovery. */
export function extractLinks(html: string, baseUrl: string): string[] {
  const links = new Set<string>();
  const re = /<a\s+[^>]*href=["']([^"'#]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      links.add(new URL(m[1], baseUrl).href);
    } catch {
      /* skip malformed */
    }
  }
  return [...links];
}

/** Strips tags for quick text-based extraction (emails, meta description). Real DOM parsing (cheerio) can be layered on by a plugin if it needs structure. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractMetaDescription(html: string): string | null {
  const m = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i);
  return m ? m[1].trim() : null;
}
