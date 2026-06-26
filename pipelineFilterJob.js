/**
 * CompX — pipelineFilterJob.js
 *
 * CHANGES (startup-optimized):
 *   1. enrichJob এর নতুন return values handle — hunterUsed, patternPredicted, techStack
 *   2. Pattern predicted email দিয়েও promote হবে (আগে শুধু real email এ হত)
 *   3. tech_stack DB update এ যোগ হয়েছে
 *   4. social_links আরো ভালোভাবে merge হচ্ছে
 *   5. enrichAndDecide এ linkedin আলাদাভাবে save হচ্ছে
 */

import { supabase }              from "../config/supabase.js";
import { buildVerifiedLeadRow }  from "../lib/promoteLead.js";
import { runEnrichJob }          from "./enrichJob.js";

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

  // Max attempts → garbage
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

  // ── enrichJob 의 새 return values 처리 ────────────────────────────────────
  const email       = enrichResult?.work_email || enrichResult?.emails?.[0] || null;
  const phone       = enrichResult?.phones?.[0] || null;
  const techStack   = enrichResult?.techStack   || [];
  const hunterUsed  = enrichResult?.hunterUsed  || false;
  const patternPredicted = enrichResult?.patternPredicted || false;

  // social_links — enrichResult 의 socials 와 기존 데이터 merge
  const socialLinks = {
    ...(dbLead.social_links || {}),
    ...(enrichResult?.social_links || {}),
    ...(enrichResult?.socials      || {}),
  };

  // LinkedIn 따로 추출
  const linkedin = enrichResult?.socials?.linkedin
    || enrichResult?.social_links?.linkedin
    || socialLinks?.linkedin
    || null;

  console.log(
    `[PipelineFilter] Enrich result: email=${email || "none"}` +
    ` phone=${phone || "none"}` +
    ` hunter=${hunterUsed}` +
    ` pattern=${patternPredicted}` +
    ` tech=${techStack.join(",") || "none"}`
  );

  if (!email) {
    // email নেই — staging এ রাখো, পাওয়া data save করো
    console.log(`[PipelineFilter] No email found → staging (attempt ${attempts}/${MAX_ENRICH_ATTEMPTS})`);

    await supabase
      .from("leads_staging")
      .update({
        status:       "failed",
        phone:        phone        || dbLead.phone,
        social_links: socialLinks,
        tech_stack:   techStack,   // নতুন — আগে missing ছিল
        linkedin_url: linkedin     || dbLead.linkedin_url || null,
        updated_at:   new Date().toISOString(),
      })
      .eq("id", dbLead.id);

    await supabase
      .from("leads_enrichment_queue")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("staging_id", dbLead.id);

    return { kept: true, reason: "no_email_but_has_website", attempt: attempts };
  }

  // Email পেয়েছি — promote করো
  // pattern predicted email দিয়েও promote হবে (পরে verify করা যাবে)
  if (patternPredicted) {
    console.log(`[PipelineFilter] Pattern predicted email: ${email} — promoting with low confidence`);
  }
  if (hunterUsed) {
    console.log(`[PipelineFilter] Hunter.io email: ${email} — promoting`);
  }

  const enrichedLead = {
    ...dbLead,
    email,
    phone:            phone        || dbLead.phone,
    social_links:     socialLinks,
    tech_stack:       techStack,
    linkedin_url:     linkedin     || dbLead.linkedin_url || null,
    email_source:     patternPredicted ? "pattern" : hunterUsed ? "hunter" : "scrape",
  };

  await supabase
    .from("leads_enrichment_queue")
    .update({ status: "completed", updated_at: new Date().toISOString() })
    .eq("staging_id", dbLead.id);

  console.log(`[PipelineFilter] Enriched — promoting directly`);
  return await promoteToLeads(enrichedLead, orgId);
}

// ── Promote → leads_verified ──────────────────────────────────────────────────
async function promoteToLeads(dbLead, orgId) {
  const resolvedOrgId = orgId || dbLead.org_id;

  // Duplicate check — same email + org
  if (dbLead.email) {
    const { data: existing } = await supabase
      .from("leads_verified")
      .select("id")
      .eq("email",  dbLead.email)
      .eq("org_id", resolvedOrgId)
      .maybeSingle();

    if (existing) {
      console.log(`[PipelineFilter] Duplicate email ${dbLead.email} → marking duplicate`);
      await supabase
        .from("leads_staging")
        .update({ status: "duplicate", updated_at: new Date().toISOString() })
        .eq("id", dbLead.id);
      return { duplicate: true, email: dbLead.email };
    }
  }

  const verifiedRow = buildVerifiedLeadRow({ ...dbLead, org_id: resolvedOrgId });

  const { error: insertErr } = await supabase
    .from("leads_verified")
    .insert(verifiedRow);

  if (insertErr) {
    console.error("[PipelineFilter] leads_verified insert error:", insertErr.message);
    return { error: insertErr.message };
  }

  await supabase
    .from("leads_staging")
    .update({ status: "promoted", updated_at: new Date().toISOString() })
    .eq("id", dbLead.id);

  console.log(`[PipelineFilter] ✅ Promoted ${dbLead.id} → leads_verified (source: ${dbLead.email_source || "direct"})`);
  return { promoted: true, leadId: dbLead.id, emailSource: dbLead.email_source };
}

// ── Garbage bin ───────────────────────────────────────────────────────────────
async function dumpToGarbage(dbLead, orgId, userId, reason) {
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

// ── Notify user ───────────────────────────────────────────────────────────────
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