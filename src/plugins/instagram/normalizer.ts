import { extractEmailsFromText } from "@compx/scraper-core";

export function normalizeInstagramProfile(profile: Record<string, any>): Record<string, any> {
  const normalized = { ...profile };
  
  if (normalized.bio) {
    // 1. Email Extraction
    const emails = extractEmailsFromText(normalized.bio);
    if (emails.length > 0 && !normalized.email) {
      normalized.email = emails[0];
    }

    // 2. Phone Extraction (More robust international format support)
    if (!normalized.phone) {
      const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
      const phoneMatch = normalized.bio.match(phoneRegex);
      if (phoneMatch) {
        normalized.phone = phoneMatch[0].trim();
      }
    }
    
    // 3. Website Extraction (Prevents grabbing trailing punctuation like '.' or ',')
    if (!normalized.website) {
      const urlRegex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi;
      const linkMatch = normalized.bio.match(urlRegex);
      if (linkMatch) {
        // Clean up trailing slash if it's the only extra character
        normalized.website = linkMatch[0].replace(/\/$/, "");
      }
    }
  }

  return normalized;
}