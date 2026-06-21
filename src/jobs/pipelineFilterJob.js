/**
 * pipelineFilterJob.js
 * worker/src/jobs/pipelineFilterJob.js
 *
 * Pipeline:
 *  database_leads (pending)
 *    → has email+phone?  YES → promote to leads table directly
 *    → has website only? YES → enrichJob → success → leads / fail → garbage_bin
 *    → no website?            → garbage_bin (no_data)
 */

import { supabase } from "../config/supabase.js";
import { runEnrichJob } from "./enrichJob.js";

// Required fields to promote to leads table
const REQUIRED_FIELDS = ["email"];          // minimum: must have email
const PREFERRED_FIELDS = ["phone", "website"]; // nice to have

export async function runPipelineFilter(inputData, userId) {
  const { dbLeadId, orgId } = inputData;

  // 1. Fetch the staging record
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

  // 2. Already has email? → promote directly
  if (dbLead.email) {
    console.log(`[PipelineFilter] Has email already → promoting to leads`);
    return await promoteToLeads(dbLead, orgId);
  }

  // 3. Has website → try enrichment
  if (dbLead.website) {
    console.log(`[PipelineFilter] Has website, no email → triggering enrichment`);
    return await enrichAndDecide(dbLead, userId, orgId);
  }

  // 4. No website, no email → garbage
  console.log(`[PipelineFilter] No website, no email → dumping to garbage`);
  return await dumpToGarbage(dbLead, orgId, "no_data");
}

// ── Enrich via website, then decide ──────────────────────────────────────────
async function enrichAndDecide(dbLead, userId, orgId) {
  // Mark attempts and queue processing
  await supabase
    .from("leads_staging")
    .update({
      enrich_attempts: (dbLead.enrich_attempts || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", dbLead.id);

  await supabase
    .from("leads_enrichment_queue")
    .update({ status: "processing", updated_at: new Date().toISOString() })
    .eq("staging_id", dbLead.id);

  let enrichResult = null;
  try {
    enrichResult = await runEnrichJob(
      {
        website:    dbLead.website,
        domain:     dbLead.website,
        sourceType: "discover",          // ← enrichJob এ leads_verified এ insert করবে
        orgId:      orgId || dbLead.org_id,
        company:    dbLead.company || dbLead.name,
        name:       dbLead.name,
        industry:   dbLead.industry,
        phone:      dbLead.phone,
        address:    dbLead.address,
        source:     dbLead.source,
      },
      userId
    );
  } catch (err) {
    console.error("[PipelineFilter] enrichJob threw:", err.message);
  }

  // Extract useful data from enrichment
  const email        = enrichResult?.email   || enrichResult?.emails?.[0]  || null;
  const phone        = enrichResult?.phone   || enrichResult?.phones?.[0]  || null;
  const socialLinks  = enrichResult?.social_links || {};

  if (!email) {
    // Has website but no email found → keep in staging for manual review
    // (do NOT garbage — website means it could still be a valid lead)
    console.log(`[PipelineFilter] Enrichment returned no email → keeping in staging (has website)`);
    await supabase
      .from("leads_staging")
      .update({
        status:       "failed", // UI expects 'failed' for retryable, or 'enriched' if successful
        phone:        phone || dbLead.phone || null,
        social_links: socialLinks,
        updated_at:   new Date().toISOString(),
      })
      .eq("id", dbLead.id);

    await supabase
      .from("leads_enrichment_queue")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("staging_id", dbLead.id);

    return { kept: true, reason: "no_email_but_has_website" };
  }

  // Update database_lead with enriched data
  await supabase
    .from("leads_staging")
    .update({
      email,
      phone:        phone        || dbLead.phone,
      social_links: socialLinks,
      status:       "enriched",
      updated_at:   new Date().toISOString(),
    })
    .eq("id", dbLead.id);

  await supabase
    .from("leads_enrichment_queue")
    .update({ status: "completed", updated_at: new Date().toISOString() })
    .eq("staging_id", dbLead.id);

  // Promote to leads table
  const updatedLead = { ...dbLead, email, phone: phone || dbLead.phone, social_links: socialLinks };
  console.log(`[PipelineFilter] Enriched successfully → promoting to leads`);
  return await promoteToLeads(updatedLead, orgId);
}

// ── Promote database_lead → leads table (using DB function) ──────────────────
async function promoteToLeads(dbLead, orgId) {
  const { data, error } = await supabase
    .rpc("promote_to_lead", { p_staging_id: dbLead.id });

  if (error) {
    console.error("[PipelineFilter] promote_to_lead RPC error:", error.message);
    return { error: error.message };
  }

  console.log(`[PipelineFilter] Promoted → leads.id = ${data}`);
  return { promoted: true, leadId: data };
}

// ── Dump to garbage_bin ───────────────────────────────────────────────────────
async function dumpToGarbage(dbLead, orgId, reason) {
  const { error } = await supabase
    .from("garbage_bin")
    .insert({
      org_id:       orgId,
      user_id:      dbLead.user_id,
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

  // Notify user via Supabase realtime notification table (if exists)
  await notifyUser(dbLead.user_id || orgId, dbLead, reason);

  return { dumped: true, reason };
}

// ── Notify user ───────────────────────────────────────────────────────────────
async function notifyUser(userId, dbLead, reason) {
  const messages = {
    no_data:            `"${dbLead.company || dbLead.name}" has no website or email — moved to garbage.`,
    enrichment_failed:  `"${dbLead.company || dbLead.name}" website enrichment found no email — moved to garbage.`,
    email_invalid:      `"${dbLead.company || dbLead.name}" email was invalid — moved to garbage.`,
  };

  // Insert to notifications table if it exists (optional)
  try {
    await supabase.from("notifications").insert({
      user_id: userId,
      type:    "pipeline_garbage",
      title:   "Lead discarded",
      message: messages[reason] || `Lead moved to garbage: ${reason}`,
      data:    { dbLeadId: dbLead.id, reason },
      read:    false,
    });
  } catch {
    // notifications table may not exist — silent fail
  }
}
