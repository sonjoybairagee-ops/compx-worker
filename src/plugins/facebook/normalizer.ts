import { extractEmailsFromText } from "@compx/scraper-core";

export function normalizeFacebookPage(page: Record<string, any>): Record<string, any> {
  const normalized = { ...page };
  
  if (normalized.about) {
    const emails = extractEmailsFromText(normalized.about);
    if (emails.length > 0 && !normalized.email) {
      normalized.email = emails[0];
    }

    const phoneMatch = normalized.about.match(/(\+?\d[\d\s().-]{7,}\d)/);
    if (phoneMatch && !normalized.phone) {
      normalized.phone = phoneMatch[1].trim();
    }
    
    const linkMatch = normalized.about.match(/https?:\/\/[^\s]+/);
    if (linkMatch && !normalized.website) {
       normalized.website = linkMatch[0];
    }
  }

  return normalized;
}
