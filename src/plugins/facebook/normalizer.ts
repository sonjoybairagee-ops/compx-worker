import { extractEmailsFromText } from "@compx/scraper-core";

export function normalizeFacebookPage(page: Record<string, any>): Record<string, any> {
  const normalized = { ...page };
  
  if (normalized.about) {
    // 1. Email Extraction
    const emails = extractEmailsFromText(normalized.about);
    if (emails.length > 0 && !normalized.email) {
      normalized.email = emails[0];
    }

    // 2. Phone Extraction
    if (!normalized.phone) {
      const phoneRegex = /(?:\+?880|01)?[\d\s-]{8,11}|\+?[\d][\d\s().-]{7,}\d/g;
      const phoneMatch = normalized.about.match(phoneRegex);
      if (phoneMatch) {
        normalized.phone = phoneMatch[0].trim();
      }
    }
    
    // 3. FIX: Website extraction (Catches URLs without http and cleans trailing dots/commas)
    if (!normalized.website) {
      const IGNORE_DOMAINS = ['facebook.com', 'instagram.com', 'youtube.com', 'twitter.com', 'x.com', 'tiktok.com', 'linkedin.com'];
      const domainRegex = /(?:https?:\/\/)?(?:www\.)?([-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&//=]*))/gi;
      const matches = normalized.about.match(domainRegex);
      
      if (matches) {
        const validDomain = matches.find(d => {
          const clean = d.replace(/^https?:\/\//, '').replace(/^www\./, '').toLowerCase();
          return !IGNORE_DOMAINS.some(ignored => clean.includes(ignored));
        });
        
        if (validDomain) {
          normalized.website = validDomain.startsWith('http') ? validDomain : `https://${validDomain}`;
          normalized.website = normalized.website.replace(/[.,;]$/, ""); // Clean trailing punctuation
        }
      }
    }
  }

  return normalized;
}