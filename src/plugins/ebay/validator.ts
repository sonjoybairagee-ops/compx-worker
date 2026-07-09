export function validateEbayProfile(profile: Record<string, any>): Record<string, any> | null {
  if (!profile.name) return null;

  return profile;
}
