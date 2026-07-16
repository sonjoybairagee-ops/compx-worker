export function parseInstagramSerpResult(result: any): Record<string, any> | null {
  if (!result.link || !result.link.includes("instagram.com/")) return null;

  const NON_USERNAME_SEGMENTS = new Set(["p", "reel", "reels", "tv", "stories", "explore", "accounts"]);

  let username: string | null = null;

  // Priority 1: Extract from 'source' (e.g., "Instagram · username")
  if (typeof result.source === "string" && result.source.includes("·")) {
    const candidate = result.source.split("·").pop()?.trim();
    if (candidate && !NON_USERNAME_SEGMENTS.has(candidate.toLowerCase())) {
      username = candidate;
    }
  }

  // Priority 2: Fallback to URL parsing
  if (!username) {
    const usernameMatch = result.link.match(/instagram\.com\/([^\/\?]+)/);
    const candidate = usernameMatch?.[1];
    if (candidate && !NON_USERNAME_SEGMENTS.has(candidate.toLowerCase())) {
      username = candidate;
    }
  }

  if (!username) return null;

  const profileUrl = `https://www.instagram.com/${username}/`;

  let name = username;
  if (result.title) {
    // Clean up typical Google title suffixes
    name = result.title.replace(/\s*[-–]\s*Instagram.*$/i, "").replace(/\s*\|.*$/i, "").trim();
    if (!name) name = username;
  }

  let followersCount = null;
  let followingCount = null;
  let postsCount = null;
  const snippet = result.snippet || "";

  // Flexible stats matching: Handles "10K Followers, 200 Following, 50 Posts" 
  // OR variations where order/wording might slightly differ.
  const statsRegex = /(\d+(?:[\.,]?\d*)?[KMBkmb]?)\s*(?:followers?)/i;
  const followingRegex = /(\d+(?:[\.,]?\d*)?[KMBkmb]?)\s*(?:following)/i;
  const postsRegex = /(\d+(?:[\.,]?\d*)?[KMBkmb]?)\s*(?:posts?)/i;

  const parseCount = (s: string) => {
    if (!s) return null;
    const num = s.replace(/[^\d.KMBkmb]/g, "");
    const mult = /k/i.test(num) ? 1_000 : /m/i.test(num) ? 1_000_000 : /b/i.test(num) ? 1_000_000_000 : 1;
    const n = parseFloat(num.replace(/[kmbKMB]/g, ""));
    return isNaN(n) ? null : Math.round(n * mult);
  };

  const followersMatch = snippet.match(statsRegex);
  const followingMatch = snippet.match(followingRegex);
  const postsMatch = snippet.match(postsRegex);

  if (followersMatch) followersCount = parseCount(followersMatch[1]);
  if (followingMatch) followingCount = parseCount(followingMatch[1]);
  if (postsMatch) postsCount = parseCount(postsMatch[1]);

  return {
    username,
    name,
    company: name,
    bio: snippet,
    followersCount,
    followsCount: followingCount,
    postsCount,
    profileUrl,
    instagram: profileUrl,
    source: "instagram",
  };
}