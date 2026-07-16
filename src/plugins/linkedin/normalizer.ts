import { extractEmailsFromText } from "@compx/scraper-core";

export function normalizeLinkedinProfile(profile: Record<string, any>): Record<string, any> {
  const normalized = { ...profile };
  
  // 1. Email: Use parsed email, else fallback to regex on 'about'
  if (!normalized.email && normalized.about) {
    const emails = extractEmailsFromText(normalized.about);
    if (emails.length > 0) {
      normalized.email = emails[0];
    }
  }

  // 2. Website: Clean up and validate if present
  if (normalized.website) {
    let url = normalized.website.trim();
    if (!/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }
    // Remove trailing slashes or punctuation
    normalized.website = url.replace(/[\/.,;]$/, "");
  }

  // 3. Phone: Clean up spaces if present
  if (normalized.phone) {
    normalized.phone = normalized.phone.replace(/\s+/g, "").trim();
  }

  return normalized;
}