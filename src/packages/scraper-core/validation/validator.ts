/**
 * scraper-core/validation/validator.ts
 *
 * Phase 13 from the roadmap ("সব data save করবে না। Validate করবে।").
 * Centralized gatekeeper to reject junk before it ever reaches the DB.
 * 
 * FIX: Added phone as a valid contact path, fixed dedup key collision for 
 * no-website leads, and optimized phone normalization regex.
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
  
  const cleaned = raw.trim();
  // ✅ FIX: Directly count digits for efficiency
  const digitCount = (cleaned.match(/\d/g) || []).length;
  
  if (digitCount < PHONE_MIN_DIGITS) return null;
  
  // Keep only digits and the leading '+' sign
  return cleaned.replace(/[^\d+]/g, "");
}

export function isValidEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return checkEmailSyntax(email) && !isDisposableEmail(email);
}

/**
 * Validates a scraped record before it's allowed into leads_staging.
 */
export function validateLead(lead: RawLead): ValidationResult {
  const reasons: string[] = [];

  // 1. Email Validation
  const rawEmail = typeof lead.email === 'string' ? lead.email.trim() : lead.email;
  const email = rawEmail && isValidEmail(rawEmail) ? rawEmail.toLowerCase() : null;
  if (rawEmail && !email) reasons.push("email_invalid_or_disposable");

  // 2. Phone Validation
  const phone = normalizePhone(lead.phone);
  if (lead.phone && !phone) reasons.push("phone_too_short_or_invalid");

  // 3. Website Validation
  const website = normalizeWebsite(lead.website);
  if (lead.website && !website) reasons.push("website_is_social_or_unparseable");

  // 4. Identity Check
  const rawName = typeof lead.name === 'string' ? lead.name.trim() : lead.name;
  const rawCompany = typeof lead.company === 'string' ? lead.company.trim() : lead.company;
  const hasIdentity = !!(rawCompany || rawName);
  if (!hasIdentity) reasons.push("missing_company_and_name");

  // ✅ FIX: Allow valid phone as a contact path (Crucial for Instagram/LinkedIn)
  const hasContactPath = !!(email || website || phone);
  if (!hasContactPath) reasons.push("no_email_no_website_and_no_phone");

  return {
    valid: hasIdentity && hasContactPath,
    reasons,
    normalized: { email, phone, website },
  };
}

/** 
 * Dedup key generator. 
 * ✅ FIX: Prevents "no-website" collision trap by falling back to email or normalized name.
 */
export function buildDedupKey(orgId: string | null, userId: string, lead: RawLead): string {
  const org = orgId || userId; // Never null
  const website = normalizeWebsite(lead.website);
  
  // Priority 1: Website (Most reliable)
  if (website) {
    return `${org}::web::${website}`;
  }
  
  // Priority 2: Email (Highly reliable)
  const rawEmail = typeof lead.email === 'string' ? lead.email.trim().toLowerCase() : lead.email;
  if (rawEmail && isValidEmail(rawEmail)) {
    return `${org}::email::${rawEmail}`;
  }

  // Priority 3: Normalized Company/Name (Fallback to prevent "no-website" collisions)
  const identifier = (lead.company || lead.name || "unknown_entity")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // Replace spaces/special chars with hyphens
    .replace(/^-|-$/g, ""); // Trim leading/trailing hyphens

  return `${org}::id::${identifier}`;
}