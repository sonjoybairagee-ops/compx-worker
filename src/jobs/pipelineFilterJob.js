/**
 * pipelineFilterJob.js (FIXED)
 *
 * Fixes applied:
 *   1. Duplicate email check — leads_verified তে আগে আছে কিনা দেখে
 *   2. enrich_attempts max limit (3) — infinite retry বন্ধ
 *   3. Webhook fallback সরিয়ে direct promote — silent staging stuck বন্ধ
 *   4. org_id null fallback — garbage_bin orphan record বন্ধ
 *   5. sourceType "discover" misleading parameter সরানো
 */

import { supabase } from "../config/supabase.js";
import { buildVerifiedLeadRow } from "../lib/promoteLead.js";
import { runEnrichJob } from "./enrichJob.js";

const MAX_ENRICH_ATTEMPTS = 3;

export async function runPipelineFilter(inputData, userId) {
  const { dbLeadId, orgId, billingUserId } = inputData;
  const billUser = billingUserId || userId;

  const { data: dbLead, error: fetchErr } = await supabase
    .from("leads_staging")
    .select("*")
    .eq("id", dbLeadId)
    .single();

  if (fetchErr || !dbLead) {
    console.error("[PipelineFilter] Cannot fetch dbLead:", dbLeadId, fetchErr?.message);
    return { error: "record_not_found" };
  }

  console.log(`[PipelineFilter] Processing: ${dbLead.company || dbLead.name} (${dbLeadId})`);

  // FIX 2: Max attempts check — এর বেশি হলে garbage তে পাঠাও
  if ((dbLead.enrich_attempts || 0) >= MAX_ENRICH_ATTEMPTS) {
    console.log(`[PipelineFilter] Max attempts (${MAX_ENRICH_ATTEMPTS}) reached → garbage`);
    return await dumpToGarbage(dbLead, orgId, userId, "max_attempts_reached");
  }

  // Email আছে → duplicate check করে promote
  if (dbLead.email) {
    console.log(`[PipelineFilter] Has email → checking duplicate then promoting`);
    return await promoteToLeads(dbLead, orgId);
  }

  // Website আছে → enrich
  if (dbLead.website) {
    console.log(`[PipelineFilter] Has website, no email → enriching`);
    return await enrichAndDecide(dbLead, billUser, orgId);
  }

  // কিছু নেই → garbage
  console.log(`[PipelineFilter] No website, no email → garbage`);
  return await dumpToGarbage(dbLead, orgId, userId, "no_data");
}

// ── Enrich ────────────────────────────────────────────────────────────────────
async function enrichAndDecide(dbLead, userId, orgId) {
  const attempts = (dbLead.enrich_attempts || 0) + 1;

  await supabase
    .from("leads_staging")
    .update({ enrich_attempts: attempts, updated_at: new Date().toISOString() })
    .eq("id", dbLead.id);

  await supabase
    .from("leads_enrichment_queue")
    .update({ status: "processing", updated_at: new Date().toISOString() })
    .eq("staging_id", dbLead.id);

  let enrichResult = null;
  try {
    enrichResult = await runEnrichJob(
      {
        website:  dbLead.website,
        domain:   dbLead.website,
        // FIX 5: sourceType "discover" সরানো — enrichJob এ duplicate insert করত
        orgId:    orgId || dbLead.org_id,
        company:  dbLead.company || dbLead.name,
        name:     dbLead.name,
        industry: dbLead.industry,
        phone:    dbLead.phone,
        address:  dbLead.address,
        source:   dbLead.source,
      },
      userId
    );
  } catch (err) {
    console.error("[PipelineFilter] enrichJob threw:", err.message);
  }

  const email       = enrichResult?.work_email || enrichResult?.emails?.[0] || null;
  const phone       = enrichResult?.phones?.[0] || null;
  const socialLinks = enrichResult?.social_links || {};

  if (!email) {
    console.log(`[PipelineFilter] No email found → keeping in staging (attempt ${attempts}/${MAX_ENRICH_ATTEMPTS})`);
    await supabase
      .from("leads_staging")
      .update({ status: "failed", phone: phone || dbLead.phone, social_links: socialLinks, updated_at: new Date().toISOString() })
      .eq("id", dbLead.id);

    await supabase
      .from("leads_enrichment_queue")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("staging_id", dbLead.id);

    return { kept: true, reason: "no_email_but_has_website", attempt: attempts };
  }

  // FIX 3: Webhook dependency সরানো — এখানেই directly promote করো
  // আগে: status="enriched" করে webhook এর উপর ছেড়ে দিত → silent stuck হত
  const enrichedLead = {
    ...dbLead,
    email,
    phone:        phone || dbLead.phone,
    social_links: socialLinks,
  };

  await supabase
    .from("leads_enrichment_queue")
    .update({ status: "completed", updated_at: new Date().toISOString() })
    .eq("staging_id", dbLead.id);

  console.log(`[PipelineFilter] Enriched — promoting directly (no webhook dependency)`);
  return await promoteToLeads(enrichedLead, orgId);
}

// ── Promote → leads_verified ──────────────────────────────────────────────────
async function promoteToLeads(dbLead, orgId) {
  const resolvedOrgId = orgId || dbLead.org_id;

  // FIX 1: Duplicate check — same email + org এ আগে আছে কিনা
  if (dbLead.email) {
    const { data: existing } = await supabase
      .from("leads_verified")
      .select("id")
      .eq("email", dbLead.email)
      .eq("org_id", resolvedOrgId)
      .maybeSingle();

    if (existing) {
      console.log(`[PipelineFilter] Duplicate email ${dbLead.email} → marking as duplicate`);
      await supabase
        .from("leads_staging")
        .update({ status: "duplicate", updated_at: new Date().toISOString() })
        .eq("id", dbLead.id);
      return { duplicate: true, email: dbLead.email };
    }
  }

  const { error: insertErr } = await supabase
    .from("leads_verified")
    .insert(buildVerifiedLeadRow({ ...dbLead, org_id: resolvedOrgId }));

  if (insertErr) {
    console.error("[PipelineFilter] leads_verified insert error:", insertErr.message);
    return { error: insertErr.message };
  }

  await supabase
    .from("leads_staging")
    .update({ status: "promoted", updated_at: new Date().toISOString() })
    .eq("id", dbLead.id);

  console.log(`[PipelineFilter] Promoted ${dbLead.id} → leads_verified`);
  return { promoted: true, leadId: dbLead.id };
}

// ── Garbage bin ───────────────────────────────────────────────────────────────
async function dumpToGarbage(dbLead, orgId, userId, reason) {
  // FIX 4: org_id null fallback — garbage record orphan বন্ধ
  const resolvedOrgId = orgId || dbLead.org_id || userId;

  const { error } = await supabase
    .from("garbage_bin")
    .insert({
      org_id:       resolvedOrgId,
      user_id:      dbLead.user_id || userId,
      source_table: "leads_staging",
      source_id:    dbLead.id,
      reason,
      data:         dbLead,
      notified:     false,
      expires_at:   new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });

  if (error) {
    console.error("[PipelineFilter] garbage_bin insert error:", error.message);
  }

  await supabase
    .from("leads_staging")
    .update({ status: "garbage", updated_at: new Date().toISOString() })
    .eq("id", dbLead.id);

  await notifyUser(dbLead.user_id || userId, dbLead, reason);
  return { dumped: true, reason };
}

// ── Notify ────────────────────────────────────────────────────────────────────
async function notifyUser(userId, dbLead, reason) {
  const messages = {
    no_data:              `"${dbLead.company || dbLead.name}" has no website or email — moved to garbage.`,
    enrichment_failed:    `"${dbLead.company || dbLead.name}" enrichment found no email — moved to garbage.`,
    email_invalid:        `"${dbLead.company || dbLead.name}" email was invalid — moved to garbage.`,
    max_attempts_reached: `"${dbLead.company || dbLead.name}" enrichment failed after ${MAX_ENRICH_ATTEMPTS} attempts — moved to garbage.`,
  };

  try {
    await supabase.from("notifications").insert({
      user_id: userId,
      type:    "pipeline_garbage",
      title:   "Lead discarded",
      message: messages[reason] || `Lead moved to garbage: ${reason}`,
      data:    { dbLeadId: dbLead.id, reason },
      read:    false,
    });
  } catch {}
}
