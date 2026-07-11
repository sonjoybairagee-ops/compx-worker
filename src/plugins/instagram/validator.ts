export function validateInstagramProfile(profile: Record<string, any>): Record<string, any> | null {
  if (!profile.username) return null;

  // Sanitize numeric fields
  if (profile.followersCount !== null && profile.followersCount < 0) profile.followersCount = 0;
  if (profile.followsCount !== null && profile.followsCount < 0) profile.followsCount = 0;
  if (profile.postsCount !== null && profile.postsCount < 0) profile.postsCount = 0;

  // Validate website (simple regex)
  if (profile.website) {
    if (!/^https?:\/\//i.test(profile.website) || profile.website.includes("instagram.com")) {
      profile.website = null;
    }
  }

  // Ensure minimum viable data (e.g., must have a username and some name)
  if (!profile.name) profile.name = profile.username;

  return profile;
}
