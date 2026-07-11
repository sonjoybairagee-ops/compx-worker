import { extractEmailsFromText } from "@compx/scraper-core";

export function normalizeInstagramProfile(profile: Record<string, any>): Record<string, any> {
  const normalized = { ...profile };
  
  if (normalized.bio) {
    const emails = extractEmailsFromText(normalized.bio);
    if (emails.length > 0 && !normalized.email) {
      normalized.email = emails[0];
    }

    const phoneMatch = normalized.bio.match(/(\+?\d[\d\s().-]{7,}\d)/);
    if (phoneMatch && !normalized.phone) {
      normalized.phone = phoneMatch[1].trim();
    }
    
    // Website extraction if present in bio and not caught elsewhere
    const linkMatch = normalized.bio.match(/https?:\/\/[^\s]+/);
    if (linkMatch && !normalized.website) {
       normalized.website = linkMatch[0];
    }
  }

  return normalized;
}
