export function validateLinkedinProfile(profile: Record<string, any>): Record<string, any> | null {
  if (!profile.name || !profile.linkedin) return null;

  if (profile.name.toLowerCase() === "linkedin member") return null;

  return profile;
}
