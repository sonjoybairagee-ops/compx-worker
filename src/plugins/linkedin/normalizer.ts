import { extractEmailsFromText } from "@compx/scraper-core";

export function normalizeLinkedinProfile(profile: Record<string, any>): Record<string, any> {
  const normalized = { ...profile };
  
  if (normalized.about) {
    const emails = extractEmailsFromText(normalized.about);
    if (emails.length > 0 && !normalized.email) {
      normalized.email = emails[0];
    }
  }

  return normalized;
}
