/**
 * scraper-core/parser/domain.ts
 *
 * The old codebase had two separate domain-normalization functions:
 *   - worker/jobs/dispatcher.js::normalizeDomain()   → strips protocol/www, no social filter
 *   - worker/jobs/pipelineSave.js::normalizeWebsite() → does the above + social-domain rejection
 * They agreed on the easy cases but diverged on edge cases (e.g. dispatcher's
 * version would happily "normalize" a facebook.com URL that pipelineSave
 * would reject). One canonical implementation now.
 */

export const SOCIAL_DOMAINS = [
  "facebook.com", "instagram.com", "twitter.com", "x.com",
  "linkedin.com", "youtube.com", "tiktok.com", "pinterest.com",
  "snapchat.com", "threads.net", "t.me", "wa.me", "amazon.com",
];

/** Bare hostname, lowercased, no protocol/www/path. Returns "" if unparseable. */
export function normalizeDomain(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .toLowerCase();
}

/**
 * Full https URL, normalized, with social-media domains rejected (returns
 * null for those — a Facebook/Instagram URL is not a "company website").
 */
export function normalizeWebsite(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url = raw.trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  try {
    const parsed = new URL(url);
    const isSocial = SOCIAL_DOMAINS.some((d) => parsed.hostname.includes(d));
    if (isSocial) return null;
    return parsed.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function isSocialDomain(hostnameOrUrl: string): boolean {
  const lower = hostnameOrUrl.toLowerCase();
  return SOCIAL_DOMAINS.some((d) => lower.includes(d));
}
