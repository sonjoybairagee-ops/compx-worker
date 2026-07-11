export function parseInstagramSerpResult(result: any): Record<string, any> | null {
  if (!result.link || !result.link.includes("instagram.com/")) return null;

  // FIX: username was being guessed from the first path segment of `link`
  // (e.g. instagram.com/werrestaurants/ -> "werrestaurants"). That only
  // works for actual profile URLs. For post/reel results — which SerpApi
  // returns just as often, e.g. instagram.com/p/DORiT4LEuu0/ or
  // instagram.com/reel/DYStmeuk0pR/ — the same regex grabbed the literal
  // path segment "p" or "reel" as the "username" (this is exactly how a
  // lead ended up saved with username "@p"). `result.source` is far more
  // reliable: SerpApi always formats it as "Instagram · <username>" for
  // both profile and post/reel results, so prefer that and only fall back
  // to link-parsing (skipping known non-username segments) if it's ever
  // missing or malformed.
  const NON_USERNAME_SEGMENTS = new Set(["p", "reel", "reels", "tv", "stories", "explore"]);

  let username: string | null = null;

  if (typeof result.source === "string" && result.source.includes("·")) {
    const candidate = result.source.split("·").pop()?.trim();
    if (candidate) username = candidate;
  }

  if (!username) {
    const usernameMatch = result.link.match(/instagram\.com\/([^\/]+)/);
    const candidate = usernameMatch?.[1];
    if (candidate && !NON_USERNAME_SEGMENTS.has(candidate.toLowerCase())) {
      username = candidate;
    }
  }

  if (!username) return null;

  // Profile URL should always point at the actual profile, not the
  // post/reel the result happened to link to.
  const profileUrl = `https://www.instagram.com/${username}/`;

  let name = username;
  if (result.title) {
    name = result.title.replace(/\s*-?\s*Instagram.*$/i, "").trim();
  }

  let followersCount = null;
  let followingCount = null;
  let postsCount = null;
  let bio = result.snippet || "";

  const snippet = result.snippet || "";
  
  // Typical Google snippet for Instagram: "10K Followers, 200 Following, 50 Posts - See Instagram photos and videos from Name (@username)"
  const statsMatch = snippet.match(/([\d.,]+[KMB]?)\s*Followers,?\s*([\d.,]+[KMB]?)\s*Following,?\s*([\d.,]+[KMB]?)\s*Posts/i);
  if (statsMatch) {
    const parseCount = (s: string) => {
      const num = s.replace(/[^\d.KMBkmb]/g, "");
      const mult = /k/i.test(num) ? 1_000 : /m/i.test(num) ? 1_000_000 : /b/i.test(num) ? 1_000_000_000 : 1;
      const n = parseFloat(num.replace(/[kmbKMB]/g, ""));
      return isNaN(n) ? null : Math.round(n * mult);
    };
    
    followersCount = parseCount(statsMatch[1]);
    followingCount = parseCount(statsMatch[2]);
    postsCount = parseCount(statsMatch[3]);
  }

  return {
    username,
    name,
    company: name,
    bio,
    followersCount,
    followsCount: followingCount,
    postsCount,
    profileUrl,
    instagram: profileUrl,
    source: "instagram",
  };
}
