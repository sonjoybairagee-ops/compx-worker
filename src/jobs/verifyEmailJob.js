/**
 * CompX Worker — src/jobs/verifyEmailJob.js
 *
 * CHANGES (startup-optimized):
 *   1. Pattern predicted email — score আলাদাভাবে handle (garbage এ যাবে না)
 *   2. NeverBounce না থাকলে MX-only mode এ চলে — crash করে না
 *   3. email_source aware scoring — pattern email এ lower threshold
 *   4. leads_verified table এ update যোগ (আগে শুধু leads table ছিল)
 *   5. Rate limiting — verify এর মাঝে delay বাড়ানো হয়েছে
 */

import dns       from "dns/promises";
import { supabase } from "../config/supabase.js";

// ── Disposable email domains ──────────────────────────────────────────────────
const DISPOSABLE = new Set([
  "mailinator.com","guerrillamail.com","10minutemail.com","tempmail.com",
  "throwam.com","yopmail.com","sharklasers.com","trashmail.com",
  "trashmail.net","maildrop.cc","dispostable.com","fakeinbox.com",
  "mailnull.com","spam4.me","spamgourmet.com","getairmail.com",
  "filzmail.com","discard.email","yopmail.fr","guerrillamail.info",
]);

// ── Helpers ───────────────────────────────────────────────────────────────────
function checkSyntax(email) {
  return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email?.trim() || "");
}

async function getMX(domain) {
  try {
    const records = await dns.resolveMx(domain);
    return records.sort((a, b) => a.priority - b.priority).map(r => r.exchange);
  } catch {
    return [];
  }
}

// ── NeverBounce (optional — না থাকলে MX-only mode) ───────────────────────────
async function neverBounceCheck(email) {
  const KEY = process.env.NEVERBOUNCE_API_KEY;
  if (!KEY) {
    // KEY নেই → MX check দিয়েই চলো, crash করবে না
    return { status: "unknown", code: null, skipped: true };
  }

  try {
    const res  = await fetch(
      `https://api.neverbounce.com/v4/single/check?key=${KEY}&email=${encodeURIComponent(email)}`,
      { signal: AbortSignal.timeout(8000) }
    );
    const data = await res.json();

    return {
      status: data.result === "valid"      ? "valid"    :
              data.result === "invalid"    ? "invalid"  :
              data.result === "disposable" ? "invalid"  :
              data.result === "catchall"   ? "catchall" :
              "unknown",
      code:    data.result,
      skipped: false,
    };
  } catch (err) {
    console.warn(`[VerifyEmail] NeverBounce error: ${err.message} — falling back to MX-only`);
    return { status: "unknown", code: null, skipped: true };
  }
}

// ── Pattern score — email prefix কতটা "real" মনে হচ্ছে ─────────────────────
function patternScore(email) {
  const prefix = email.split("@")[0].toLowerCase();
  if (/^[a-z]+\.[a-z]+$/.test(prefix))                 return 90; // john.doe
  if (/^[a-z]{2,}[a-z]{2,}$/.test(prefix))             return 80; // johndoe
  if (/^[a-z]\.[a-z]+$/.test(prefix))                   return 75; // j.doe
  if (/^(info|contact|hello|support|hi)$/.test(prefix)) return 85; // generic contact
  if (/^[a-z]+[0-9]*$/.test(prefix))                    return 65; // john123
  return 50;
}

// ── Single email verify ───────────────────────────────────────────────────────
async function verifyOne(email, emailSource = "scrape") {
  const result = {
    email,
    status:    "unknown",
    valid:     false,
    score:     0,
    emailSource,
    checks: {
      syntax:     false,
      hasMX:      false,
      disposable: false,
      smtp:       null,
      smtpCode:   null,
      nbSkipped:  false,
    },
    verifiedAt: new Date().toISOString(),
  };

  // Layer 1: Syntax
  result.checks.syntax = checkSyntax(email);
  if (!result.checks.syntax) {
    result.status = "invalid";
    return result;
  }

  const domain = email.split("@")[1].toLowerCase();

  // Layer 2: Disposable
  result.checks.disposable = DISPOSABLE.has(domain);
  if (result.checks.disposable) {
    result.status = "disposable";
    result.score  = 5;
    return result;
  }

  // Layer 3: MX record
  const mx = await getMX(domain);
  result.checks.hasMX = mx.length > 0;
  if (!result.checks.hasMX) {
    result.status = "invalid";
    result.score  = 0;
    return result;
  }

  // Layer 4: NeverBounce (optional)
  const apiCheck = await neverBounceCheck(email);
  result.checks.smtp      = apiCheck.status;
  result.checks.smtpCode  = apiCheck.code;
  result.checks.nbSkipped = apiCheck.skipped;

  // Score calculation
  const base       = result.checks.syntax ? 30 : 0;
  const mxPts      = result.checks.hasMX  ? 20 : 0;
  const patternPts = patternScore(email);

  const smtpPts =
    result.checks.smtp === "valid"    ? 40  :
    result.checks.smtp === "catchall" ? 10  :
    result.checks.smtp === "invalid"  ? -60 : 0;

  result.score = Math.max(0, Math.min(100,
    base + mxPts + smtpPts + Math.round(patternPts * 0.1)
  ));

  // Pattern predicted email — threshold আলাদা
  // scrape/hunter: >= 70 valid, pattern: >= 50 valid (কম strict)
  const validThreshold = emailSource === "pattern" ? 50 : 70;
  result.valid = result.score >= validThreshold;

  result.status =
    result.score >= 80 ? "valid"   :
    result.score >= 50 ? "risky"   :
    result.score >= 20 ? "unknown" : "invalid";

  // Pattern email — NeverBounce skip হলে "risky" রাখো, invalid করো না
  if (emailSource === "pattern" && apiCheck.skipped && result.score >= 50) {
    result.status = "risky";
    result.valid  = true;
  }

  return result;
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function runVerifyEmail(inputData, userId) {
  const { email, emails, leadId, orgId, emailSource = "scrape" } = inputData;

  const list = emails?.length ? emails : (email ? [email] : []);
  if (!list.length) return { error: "No emails provided" };

  console.log(`[VerifyEmail] Verifying ${list.length} email(s) for lead ${leadId} (source: ${emailSource})`);

  const results = [];
  for (const e of list) {
    const r = await verifyOne(e, emailSource);
    results.push(r);
    // Rate limiting — NeverBounce rate limit avoid
    await new Promise(res => setTimeout(res, 500));
  }

  results.sort((a, b) => b.score - a.score);
  const best = results[0];

  console.log(`[VerifyEmail] Best: ${best.email} — ${best.status} (score: ${best.score}, source: ${emailSource})`);

  // Credit deduct
  if (orgId) {
    try {
      await supabase.rpc("deduct_credits", { p_org_id: orgId, p_amount: 1 });
    } catch (err) {
      console.error("[VerifyEmail] Credit deduct error:", err.message);
    }
  }

  // DB update
  if (leadId) {
    if (best.status === "invalid") {
      // Pattern email invalid হলে garbage তে না পাঠিয়ে শুধু flag করো
      // (pattern email অনেক সময় invalid দেখায় কিন্তু কাজ করে)
      if (emailSource === "pattern") {
        console.log(`[VerifyEmail] Pattern email "${best.email}" invalid — flagging only, not garbage`);
        await _updateLeadEmail(leadId, best, "flagged");
        return { results, best };
      }

      console.log(`[VerifyEmail] Invalid → garbage: ${leadId}`);
      await _moveToGarbage(leadId, userId, orgId, best);

    } else {
      await _updateLeadEmail(leadId, best, "verified");

      // leads_verified table ও update করো (আগে missing ছিল)
      await supabase
        .from("leads_verified")
        .update({
          email_verified: best.status,
          email_score:    best.score,
          updated_at:     new Date().toISOString(),
        })
        .eq("id", leadId);
    }
  }

  return { results, best };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function _updateLeadEmail(leadId, best, action = "verified") {
  const updateData = {
    email_verified: action === "flagged" ? "flagged" : best.status,
    email_score:    best.score,
    updated_at:     new Date().toISOString(),
  };

  // valid হলে email column ও update করো
  if (best.valid && action !== "flagged") {
    updateData.email = best.email;
  }

  // invalid বা flagged হলে status update করো
  if (best.status === "invalid" || action === "flagged") {
    updateData.status = action === "flagged" ? "email_unverified" : "invalid_email";
  }

  await supabase.from("leads").update(updateData).eq("id", leadId);
}

async function _moveToGarbage(leadId, userId, orgId, best) {
  const { data: leadData } = await supabase
    .from("leads")
    .select("*")
    .eq("id", leadId)
    .single();

  await supabase.from("garbage_bin").insert({
    org_id:       orgId || leadData?.org_id,
    user_id:      userId,
    source_table: "leads",
    source_id:    leadId,
    reason:       "email_invalid",
    data:         { ...leadData, verify_result: best },
    notified:     false,
    expires_at:   new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });

  await supabase.from("leads").update({
    email_verified: "invalid",
    email_score:    best.score,
    status:         "invalid_email",
    updated_at:     new Date().toISOString(),
  }).eq("id", leadId);

  try {
    await supabase.from("notifications").insert({
      user_id: userId,
      type:    "email_invalid",
      title:   "Email verification failed",
      message: `Email ${best.email} is invalid — lead moved to garbage.`,
      data:    { leadId, email: best.email, score: best.score },
      read:    false,
    });
  } catch {}
}