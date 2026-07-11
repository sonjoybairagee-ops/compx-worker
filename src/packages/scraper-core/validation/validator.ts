/**
 * scraper-core/validation/validator.ts
 *
 * Phase 13 from the roadmap ("সব data save করবে না। Validate করবে।").
 * The old codebase had validation logic scattered and duplicated across
 * verifyEmailJob.js (email), pipelineFilterJob.js (attempt limits) and
 * pipelineSave.js (website/social filtering) — none of it reusable by a
 * plugin before a save even happens. This gives every plugin one place to
 * ask "is this record worth saving at all?" before it ever reaches the DB.
 */

import { checkEmailSyntax, isDisposableEmail } from "../parser/email.js";
import { normalizeWebsite } from "../parser/domain.js";

export interface RawLead {
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  company?: string | null;
  name?: string | null;
  [key: string]: any;
}

export interface ValidationResult {
  valid: boolean;
  reasons: string[]; // failure reasons, empty if valid
  normalized: {
    email: string | null;
    phone: string | null;
    website: string | null;
  };
}

const PHONE_MIN_DIGITS = 7;

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  const digitCount = digits.replace(/\D/g, "").length;
  if (digitCount < PHONE_MIN_DIGITS) return null;
  return digits;
}

export function isValidEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return checkEmailSyntax(email) && !isDisposableEmail(email);
}

/**
 * Validates a scraped record before it's allowed into leads_staging.
 * A record with NEITHER a usable email NOR a website is rejected outright
 * (mirrors pipelineFilterJob.js's "no website, no email → garbage" rule,
 * but applied at scrape time so junk never even reaches staging).
 */
export function validateLead(lead: RawLead): ValidationResult {
  const reasons: string[] = [];

  const email = lead.email && isValidEmail(lead.email) ? lead.email.toLowerCase() : null;
  if (lead.email && !email) reasons.push("email_invalid_or_disposable");

  const phone = normalizePhone(lead.phone);
  if (lead.phone && !phone) reasons.push("phone_too_short");

  const website = normalizeWebsite(lead.website);
  if (lead.website && !website) reasons.push("website_is_social_or_unparseable");

  const hasIdentity = !!(lead.company || lead.name);
  if (!hasIdentity) reasons.push("missing_company_and_name");

  const hasContactPath = !!(email || website);
  if (!hasContactPath) reasons.push("no_email_and_no_website");

  return {
    valid: hasIdentity && hasContactPath,
    reasons,
    normalized: { email, phone, website },
  };
}

/** Dedup key generator — mirrors pipelineSave.js's org_id+website conflict key, with the org_id||user_id fallback bug fix already applied there kept intact. */
export function buildDedupKey(orgId: string | null, userId: string, website: string | null): string {
  const org = orgId || userId; // never null — Postgres treats NULL != NULL, breaking unique constraints
  return `${org}::${website || "no-website"}`;
}
