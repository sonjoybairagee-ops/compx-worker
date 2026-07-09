export function validateTripadvisorProfile(profile: Record<string, any>): Record<string, any> | null {
  if (!profile.name || !profile.tripadvisor || !profile.tripadvisor.includes("tripadvisor.com")) return null;

  // Sometimes SerpApi returns generic tripadvisor pages, we want specific places/hotels/restaurants
  if (profile.tripadvisor.includes("/Search") || profile.tripadvisor.includes("/ShowForum")) return null;

  return profile;
}
