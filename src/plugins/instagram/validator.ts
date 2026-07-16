export function validateInstagramProfile(profile: Record<string, any>): Record<string, any> | null {
  if (!profile.username) return null;

  // Clean username (remove leading @ if present)
  profile.username = profile.username.replace(/^@/, "");

  // Sanitize numeric fields
  if (profile.followersCount !== null && profile.followersCount < 0) profile.followersCount = 0;
  if (profile.followsCount !== null && profile.followsCount < 0) profile.followsCount = 0;
  if (profile.postsCount !== null && profile.postsCount < 0) profile.postsCount = 0;

  // Validate and normalize website
  if (profile.website) {
    let url = profile.website.trim();
    // Ensure it has a protocol
    if (!/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }
    // Reject internal Instagram links or invalid URLs
    if (url.includes("instagram.com") || url.includes("goo.gl")) {
      profile.website = null;
    } else {
      profile.website = url;
    }
  }

  // Ensure minimum viable data
  if (!profile.name || profile.name === "") {
    profile.name = profile.username;
  }
  if (!profile.company || profile.company === "") {
    profile.company = profile.name;
  }

  return profile;
}