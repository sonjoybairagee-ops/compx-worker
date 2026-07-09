/**
 * scraper-core/parser/email.ts
 *
 * Ported from worker/jobs/verifyEmailJob.js — checkSyntax(), patternScore(),
 * DISPOSABLE set. Moved here because these are pure parsing/scoring
 * functions with no DB/queue dependency — scraper-core plugins (e.g. the
 * website plugin predicting a contact email pattern) need them too, and
 * previously would have had to import from the jobs layer, which inverts
 * the intended dependency direction (jobs → core, not core → jobs).
 */

export const DISPOSABLE_EMAIL_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com",
  "throwam.com", "yopmail.com", "sharklasers.com", "trashmail.com",
  "trashmail.net", "maildrop.cc", "dispostable.com", "fakeinbox.com",
  "mailnull.com", "spam4.me", "spamgourmet.com", "getairmail.com",
  "filzmail.com", "discard.email", "yopmail.fr", "guerrillamail.info",
]);

export function checkEmailSyntax(email: string | null | undefined): boolean {
  return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email?.trim() || "");
}

export function isDisposableEmail(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  return !!domain && DISPOSABLE_EMAIL_DOMAINS.has(domain);
}

/** Heuristic 0-100 "does this look like a real person's inbox" score, from the email's local part shape. */
export function patternScore(email: string): number {
  const prefix = email.split("@")[0]?.toLowerCase() || "";
  if (/^[a-z]+\.[a-z]+$/.test(prefix)) return 90; // john.doe
  if (/^[a-z]{2,}[a-z]{2,}$/.test(prefix)) return 80; // johndoe
  if (/^[a-z]\.[a-z]+$/.test(prefix)) return 75; // j.doe
  if (/^(info|contact|hello|support|hi)$/.test(prefix)) return 85; // generic contact
  if (/^[a-z]+[0-9]*$/.test(prefix)) return 65; // john123
  return 50;
}

export interface NameParts {
  first: string;
  last?: string;
}

/** Common company email patterns, ranked most→least likely. Used to predict a contact email from a name + domain when scraping finds neither. */
export function predictEmailPatterns(name: NameParts, domain: string): string[] {
  const first = name.first?.toLowerCase().replace(/[^a-z]/g, "");
  const last = name.last?.toLowerCase().replace(/[^a-z]/g, "");
  if (!first || !domain) return [];

  const patterns: string[] = [`${first}@${domain}`];
  if (last) {
    patterns.push(
      `${first}.${last}@${domain}`,
      `${first}${last}@${domain}`,
      `${first[0]}${last}@${domain}`,
      `${first}.${last[0]}@${domain}`
    );
  }
  return patterns;
}

export function extractEmailsFromText(text: string): string[] {
  const matches = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
  return [...new Set(matches.map((e) => e.toLowerCase()))].filter(
    (e) => !isDisposableEmail(e)
  );
}
