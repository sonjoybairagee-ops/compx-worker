/**
 * CompX Worker — src/jobs/verifyEmailJob.js
 * Server-side email verification — NeverBounce/ZeroBounce method
 *
 * Layers:
 * 1. Syntax check
 * 2. Disposable domain check
 * 3. DNS MX record lookup
 * 4. SMTP RCPT TO handshake
 * 5. Risk scoring
 * 6. Store result back to Supabase
 */

import dns from "dns/promises";
import { supabase } from "../config/supabase.js";

// ── Disposable domains ────────────────────────────────────────────────────────
const DISPOSABLE = new Set([
  "mailinator.com","guerrillamail.com","10minutemail.com","tempmail.com",
  "throwam.com","yopmail.com","sharklasers.com","trashmail.com",
  "trashmail.net","maildrop.cc","dispostable.com","fakeinbox.com",
  "mailnull.com","spam4.me","spamgourmet.com","getairmail.com",
  "filzmail.com","discard.email","yopmail.fr","guerrillamail.info",
]);

// ── Syntax check ──────────────────────────────────────────────────────────────
function checkSyntax(email) {
  return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email?.trim() || "");
}

// ── MX record lookup ──────────────────────────────────────────────────────────
async function getMX(domain) {
  try {
    const records = await dns.resolveMx(domain);
    return records.sort((a, b) => a.priority - b.priority).map(r => r.exchange);
  } catch {
    return [];
  }
}

// ── ZeroBounce API (Replaces SMTP Port 25) ──────────────────────────────────
async function zeroBounceCheck(email) {
  const KEY = process.env.ZEROBOUNCE_API_KEY;
  if (!KEY) {
    console.warn("[VerifyEmail] ZEROBOUNCE_API_KEY is not set. Skipping API validation.");
    return { status: "unknown", code: null };
  }

  try {
    const res = await fetch(
      `https://api.zerobounce.net/v2/validate?api_key=${KEY}&email=${email}`
    );
    const data = await res.json();
    
    // ZeroBounce returns: valid, invalid, catch-all, unknown, spamtrap, abuse, do_not_mail
    return { 
      status: data.status === "valid" ? "valid" : 
              data.status === "invalid" ? "invalid" : 
              data.status === "catch-all" ? "catch-all" : "unknown",
      code: data.sub_status 
    };
  } catch (error) {
    return { status: "error", code: null, message: error.message };
  }
}

// ── Pattern confidence score ──────────────────────────────────────────────────
function patternScore(email) {
  const prefix = email.split("@")[0].toLowerCase();
  if (/^[a-z]+\.[a-z]+$/.test(prefix))                     return 90; // john.doe
  if (/^[a-z]{2,}[a-z]{2,}$/.test(prefix))                 return 80; // johndoe
  if (/^[a-z]\.[a-z]+$/.test(prefix))                       return 75; // j.doe
  if (/^(info|contact|hello|support|hi)$/.test(prefix))     return 85; // generic
  if (/^[a-z]+[0-9]*$/.test(prefix))                        return 65; // john123
  return 50;
}

// ── Single email verify ───────────────────────────────────────────────────────
async function verifyOne(email) {
  const result = {
    email,
    status:    "unknown",
    valid:     false,
    score:     0,
    checks: { syntax: false, hasMX: false, disposable: false, smtp: null, smtpCode: null },
    verifiedAt: new Date().toISOString(),
  };

  // Layer 1: Syntax
  result.checks.syntax = checkSyntax(email);
  if (!result.checks.syntax) { result.status = "invalid"; return result; }

  const domain = email.split("@")[1].toLowerCase();

  // Layer 2: Disposable
  result.checks.disposable = DISPOSABLE.has(domain);
  if (result.checks.disposable) { result.status = "disposable"; result.score = 5; return result; }

  // Layer 3: MX
  const mx = await getMX(domain);
  result.checks.hasMX = mx.length > 0;
  if (!result.checks.hasMX) { result.status = "invalid"; result.score = 0; return result; }

  // Layer 4: API Validation (ZeroBounce)
  const apiCheck = await zeroBounceCheck(email);
  result.checks.smtp     = apiCheck.status;
  result.checks.smtpCode = apiCheck.code;

  // Layer 5: Score
  const base   = result.checks.syntax ? 30 : 0;
  const mxPts  = result.checks.hasMX  ? 20 : 0;
  const pattern = patternScore(email);
  const smtpPts =
    result.checks.smtp === "valid"    ? 40 :
    result.checks.smtp === "catch-all"? 10 :
    result.checks.smtp === "invalid"  ? -60 : 0;

  result.score  = Math.max(0, Math.min(100, base + mxPts + smtpPts));
  result.valid  = result.score >= 70;
  result.status =
    result.score >= 80 ? "valid"   :
    result.score >= 50 ? "risky"   :
    result.score >= 20 ? "unknown" : "invalid";

  return result;
}

// ── Main verify job ───────────────────────────────────────────────────────────
export async function runVerifyEmail(inputData, userId) {
  const { email, emails, leadId } = inputData;

  // Bulk or single
  const list = emails?.length ? emails : (email ? [email] : []);
  if (!list.length) return { error: "No emails provided" };

  console.log(`[VerifyEmail] Verifying ${list.length} email(s)`);

  const results = [];
  for (const e of list) {
    const r = await verifyOne(e);
    results.push(r);
    await new Promise(res => setTimeout(res, 300)); // rate limit safe
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  const best = results[0];

  console.log(`[VerifyEmail] Best: ${best.email} — ${best.status} (${best.score})`);

  // ── Update lead in Supabase ───────────────────────────────────────────────
  if (leadId && userId && best) {
    await supabase
      .from("extension_database")
      .update({
        email:          best.valid ? best.email : null,
        email_verified: best.status,
        email_score:    best.score,
      })
      .eq("id", leadId)
      .eq("user_id", userId);
  }

  return { results, best };
}
