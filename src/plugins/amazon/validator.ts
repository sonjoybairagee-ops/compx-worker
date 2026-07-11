export function validateAmazonProfile(profile: Record<string, any>): Record<string, any> | null {
  if (!profile.name || !profile.extra_data?.asin) return null;

  return profile;
}
