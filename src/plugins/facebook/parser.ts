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

  // ── Followers/Likes count from snippet ─────────────────────
  let followersCount: number | null = null;
  const statsMatch = snippet.match(/([\d.,]+[KMB]?)\s*(likes|followers)/i);
  if (statsMatch) {
    const parseCount = (s: string) => {
      const mult = /k/i.test(s) ? 1_000 : /m/i.test(s) ? 1_000_000 : /b/i.test(s) ? 1_000_000_000 : 1;
      const n = parseFloat(s.replace(/[^0-9.]/g, ""));
      return isNaN(n) ? null : Math.round(n * mult);
    };
    followersCount = parseCount(statsMatch[1]);
  }

  // ── Category extraction from snippet/title ──────────────────
  // Common patterns: "Restaurant · Dubai", "Marketing Agency · New York"
  let category: string | null = null;
  const categoryMatch = snippet.match(/^([A-Za-z &\/]+?)\s*[·•|]\s/) || 
                        result.title?.match(/\(([^)]+)\)/);
  if (categoryMatch) {
    const cat = categoryMatch[1].trim();
    if (cat.length > 3 && cat.length < 60 && !/facebook/i.test(cat)) {
      category = cat;
    }
  }

  // ── Website from snippet ──────────────────────────────────
  let website: string | null = null;
  const urlMatch = snippet.match(/https?:\/\/(?!(?:www\.)?facebook\.com)[^\s,)]+/);
  if (urlMatch) {
    website = urlMatch[0].replace(/[.,]$/, "");
  }

  // ── Phone from snippet ────────────────────────────────────
  let phone: string | null = null;
  const phoneMatch = snippet.match(/(\+?[\d][\d\s().-]{7,}\d)/);
  if (phoneMatch) {
    phone = phoneMatch[1].trim();
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
