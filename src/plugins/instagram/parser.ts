export function parseInstagramSerpResult(result: any): Record<string, any> | null {
  if (!result.link || !result.link.includes("instagram.com/")) return null;

  const usernameMatch = result.link.match(/instagram\.com\/([^\/]+)/);
  if (!usernameMatch) return null;
  const username = usernameMatch[1];

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
    profileUrl: result.link,
    instagram: result.link,
    source: "instagram",
  };
}
