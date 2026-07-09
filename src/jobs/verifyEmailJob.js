/**
 * jobs/verifyEmailJob.js
 *
 * Rebuilt after the worker/ folder deletion. Same behavior as the original:
 * syntax → disposable → MX → NeverBounce (optional) → score, with a lower
 * validity threshold for pattern-predicted emails. Syntax/disposable/pattern
 * checks now come from scraper-core instead of being duplicated here.
 *
 * UPDATED: fixed the `deduct_credits` RPC call — it was missing the
 * required `p_user_id` argument (only sending p_org_id + p_amount), which
 * doesn't match the deployed `deduct_credits(p_user_id, p_org_id, p_amount)`
 * signature and would silently fail every time. `userId` was already
 * available as a parameter to `runVerifyEmail`, so this needed no other
 * changes — the 1-credit-per-verify charge itself was already correct,
 * just the call was broken.
 */

import dns from "dns/promises";
import { supabase } from "../config/supabase.js";
import { checkEmailSyntax, isDisposableEmail, patternScore } from "@compx/scraper-core";

async function getMX(domain) {
  try {
    const records = await dns.resolveMx(domain);
    return records.sort((a, b) => a.priority - b.priority).map((r) => r.exchange);
  } catch {
    return [];
  }
}

async function neverBounceCheck(email) {
  const KEY = process.env.NEVERBOUNCE_API_KEY;
  if (!KEY) return { status: "unknown", code: null, skipped: true };

  try {
    const res = await fetch(
      `https://api.neverbounce.com/v4/single/check?key=${KEY}&email=${encodeURIComponent(email)}`,
      { signal: AbortSignal.timeout(8000) }
    );
    const data = await res.json();
    return {
      status:
        data.result === "valid" ? "valid" :
        data.result === "invalid" ? "invalid" :
        data.result === "disposable" ? "invalid" :
        data.result === "catchall" ? "catchall" : "unknown",
      code: data.result,
      skipped: false,
    };
  } catch (err) {
    console.warn(`[VerifyEmail] NeverBounce error: ${err.message} — falling back to MX-only`);
    return { status: "unknown", code: null, skipped: true };
  }
}

async function verifyOne(email, emailSource = "scrape") {
  const result = {
    email, status: "unknown", valid: false, score: 0, emailSource,
    checks: { syntax: false, hasMX: false, disposable: false, smtp: null, smtpCode: null, nbSkipped: false },
    verifiedAt: new Date().toISOString(),
  };

  result.checks.syntax = checkEmailSyntax(email);
  if (!result.checks.syntax) {
    result.status = "invalid";
    return result;
  }

  const domain = email.split("@")[1].toLowerCase();

  result.checks.disposable = isDisposableEmail(email);
  if (result.checks.disposable) {
    result.status = "disposable";
    result.score = 5;
    return result;
  }

  const mx = await getMX(domain);
  result.checks.hasMX = mx.length > 0;
  if (!result.checks.hasMX) {
    result.status = "invalid";
    result.score = 0;
    return result;
  }

  const apiCheck = await neverBounceCheck(email);
  result.checks.smtp = apiCheck.status;
  result.checks.smtpCode = apiCheck.code;
  result.checks.nbSkipped = apiCheck.skipped;

  const base = result.checks.syntax ? 30 : 0;
  const mxPts = result.checks.hasMX ? 20 : 0;
  const patternPts = patternScore(email);
  const smtpPts =
    result.checks.smtp === "valid" ? 40 :
    result.checks.smtp === "catchall" ? 10 :
    result.checks.smtp === "invalid" ? -60 : 0;

  result.score = Math.max(0, Math.min(100, base + mxPts + smtpPts + Math.round(patternPts * 0.1)));

  const validThreshold = emailSource === "pattern" ? 50 : 70;
  result.valid = result.score >= validThreshold;

  result.status =
    result.score >= 80 ? "valid" :
    result.score >= 50 ? "risky" :
    result.score >= 20 ? "unknown" : "invalid";

  if (emailSource === "pattern" && apiCheck.skipped && result.score >= 50) {
    result.status = "risky";
    result.valid = true;
  }

  return result;
}

export async function runVerifyEmail(inputData, userId) {
  const { email, emails, leadId, orgId, emailSource = "scrape" } = inputData;

  const list = emails?.length ? emails : (email ? [email] : []);
  if (!list.length) return { error: "No emails provided" };

  console.log(`[VerifyEmail] Verifying ${list.length} email(s) for lead ${leadId} (source: ${emailSource})`);

  const results = [];
  for (const e of list) {
    const r = await verifyOne(e, emailSource);
    results.push(r);
    await new Promise((res) => setTimeout(res, 500));
  }

  results.sort((a, b) => b.score - a.score);
  const best = results[0];

  console.log(`[VerifyEmail] Best: ${best.email} — ${best.status} (score: ${best.score}, source: ${emailSource})`);

  // FIX: was missing p_user_id — the deployed deduct_credits RPC requires
  // (p_user_id, p_org_id, p_amount). userId is always available here as a
  // parameter, so the fix needed nothing else.
  try {
    await supabase.rpc("deduct_credits", { p_user_id: userId, p_org_id: orgId || userId, p_amount: 1 });
  } catch (err) {
    console.error("[VerifyEmail] Credit deduct error:", err.message);
  }

  if (leadId) {
    if (best.status === "invalid") {
      if (emailSource === "pattern") {
        console.log(`[VerifyEmail] Pattern email "${best.email}" invalid — flagging only, not garbage`);
        await _updateLeadEmail(leadId, best, "flagged");
        return { results, best };
      }
      console.log(`[VerifyEmail] Invalid → garbage: ${leadId}`);
      await _moveToGarbage(leadId, userId, orgId, best);
    } else {
      await _updateLeadEmail(leadId, best, "verified");
      await supabase.from("leads_verified").update({
        email_verified: best.status, email_score: best.score, updated_at: new Date().toISOString(),
      }).eq("id", leadId);
    }
  }

  return { results, best };
}

async function _updateLeadEmail(leadId, best, action = "verified") {
  const updateData = {
    email_verified: action === "flagged" ? "flagged" : best.status,
    email_score: best.score,
    updated_at: new Date().toISOString(),
  };
  if (best.valid && action !== "flagged") updateData.email = best.email;
  if (best.status === "invalid" || action === "flagged") {
    updateData.status = action === "flagged" ? "email_unverified" : "invalid_email";
  }
  await supabase.from("leads").update(updateData).eq("id", leadId);
}

async function _moveToGarbage(leadId, userId, orgId, best) {
  const { data: leadData } = await supabase.from("leads").select("*").eq("id", leadId).single();

  await supabase.from("garbage_bin").insert({
    org_id: orgId || leadData?.org_id,
    user_id: userId,
    source_table: "leads",
    source_id: leadId,
    reason: "email_invalid",
    data: { ...leadData, verify_result: best },
    notified: false,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });

  await supabase.from("leads").update({
    email_verified: "invalid", email_score: best.score, status: "invalid_email", updated_at: new Date().toISOString(),
  }).eq("id", leadId);

  try {
    await supabase.from("notifications").insert({
      user_id: userId, type: "email_invalid", title: "Email verification failed",
      message: `Email ${best.email} is invalid — lead moved to garbage.`,
      data: { leadId, email: best.email, score: best.score }, read: false,
    });
  } catch {}
}
