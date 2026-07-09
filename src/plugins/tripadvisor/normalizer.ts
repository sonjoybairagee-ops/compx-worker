export function normalizeTripadvisorProfile(profile: Record<string, any>): Record<string, any> {
  const normalized = { ...profile };
  
  if (normalized.extra_data?.rating) {
    if (typeof normalized.extra_data.rating === 'string') {
      const match = normalized.extra_data.rating.match(/[\d.]+/);
      if (match) {
        normalized.extra_data.rating = parseFloat(match[0]);
      }
    }
  }

  return normalized;
}
