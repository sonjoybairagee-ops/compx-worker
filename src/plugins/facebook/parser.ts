import { extractEmailsFromText } from "@compx/scraper-core";

export function parseFacebookSerpResult(result: any): Record<string, any> | null {
  if (!result.link || !result.link.includes("facebook.com/")) return null;

  let urlObj: URL;
  try {
    urlObj = new URL(result.link);
  } catch {
    return null;
  }

  let pageSlug = urlObj.pathname.replace(/\/$/, "").split("/").pop() || "";
  if (pageSlug === "profile.php") {
    pageSlug = urlObj.searchParams.get("id") || "";
  }
  if (!pageSlug) return null;

  // Clean page name from title, e.g. "Nike | Facebook" → "Nike"
  let name = pageSlug;
  if (result.title) {
    name = result.title
      .replace(/\s*[|\-–]\s*Facebook.*$/i, "")
      .replace(/\s*-\s*Home\s*$/i, "")
      .trim();
  }

  const snippet = result.snippet || "";

  // ── Followers/Likes count ──────────────────────────────────
  let followersCount: number | null = null;
  const statsSource = `${result.displayed_link || ""} ${snippet}`;
  const statsMatch = statsSource.match(/([\d.,]+[KMB]?)\+?\s*(likes|followers)/i);
  if (statsMatch) {
    const parseCount = (s: string) => {
      const mult = /k/i.test(s) ? 1_000 : /m/i.test(s) ? 1_000_000 : /b/i.test(s) ? 1_000_000_000 : 1;
      const n = parseFloat(s.replace(/[^0-9.]/g, ""));
      return isNaN(n) ? null : Math.round(n * mult);
    };
    followersCount = parseCount(statsMatch[1]);
  }

  // ── Category extraction from snippet/title ──────────────────
  let category: string | null = null;
  const categoryMatch = snippet.match(/^([A-Za-z &\/]+?)\s*[·•|]\s/) || 
                        result.title?.match(/\(([^)]+)\)/);
  if (categoryMatch) {
    const cat = categoryMatch[1].trim();
    if (cat.length > 3 && cat.length < 60 && !/facebook/i.test(cat)) {
      category = cat;
    }
  }

  // ── FIX: Robust Website extraction from snippet ─────────────
  // Google snippets often omit http/https. This regex catches domains like "nike.com" or "www.nike.com"
  let website: string | null = null;
  const domainRegex = /(?:https?:\/\/)?(?:www\.)?([-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&//=]*))/gi;
  const domainMatches = snippet.match(domainRegex);
  if (domainMatches) {
    const IGNORE_DOMAINS = ['facebook.com', 'instagram.com', 'youtube.com', 'twitter.com', 'x.com', 'tiktok.com', 'linkedin.com'];
    const validDomain = domainMatches.find(d => {
      const clean = d.replace(/^https?:\/\//, '').replace(/^www\./, '').toLowerCase();
      return !IGNORE_DOMAINS.some(ignored => clean.includes(ignored));
    });
    if (validDomain) {
      website = validDomain.startsWith('http') ? validDomain : `https://${validDomain}`;
      // Clean trailing punctuation
      website = website.replace(/[.,;]$/, "");
    }
  }

  // ── Phone from snippet ────────────────────────────────────
  let phone: string | null = null;
  const phoneMatch = snippet.match(/(?:\+?880|01)?[\d\s-]{8,11}|\+?[\d][\d\s().-]{7,}\d/);
  if (phoneMatch) {
    phone = phoneMatch[0].trim();
  }

  return {
    pageSlug,
    name,
    company: name,
    about: snippet,
    followersCount,
    category,
    website,
    phone,
    facebook: result.link,
    source: "facebook",
    extra_data: {
      page_name: name,
      facebook_url: result.link,
      followers_count: followersCount,
      category,
    },
  };
}