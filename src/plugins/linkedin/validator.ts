export function validateLinkedinProfile(profile: Record<string, any>): Record<string, any> | null {
  // Must have a name and a valid LinkedIn URL
  if (!profile.name || !profile.linkedin) return null;

  // Filter out restricted/private profiles that Apify couldn't fully scrape
  if (profile.name.toLowerCase().includes("linkedin member")) return null;
  if (profile.contactTitle && profile.contactTitle.toLowerCase().includes("unavailable")) return null;

  // Ensure URL is actually a LinkedIn URL
  if (!profile.linkedin.includes("linkedin.com/in/")) return null;

  return profile;
}