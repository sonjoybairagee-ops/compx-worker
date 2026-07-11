/**
 * CompX — pipelineFilterJob.js
 *
 * CHANGES:
 *   1. enrichJob এর নতুন return values handle — hunterUsed, patternPredicted, techStack
 *   2. Pattern predicted email দিয়েও promote হবে (score -15 penalty)
 *   3. tech_stack DB update এ যোগ হয়েছে
 *   4. social_links আরো ভালোভাবে merge হচ্ছে
 *   5. FIX: enrichJob এ targetTable: null pass করা হচ্ছে
 *   6. FIX: enrichJob throw করলে queue "processing" এ আটকাবে না
 *   7. FIX: retry possible থাকলে status "pending", শেষ attempt এ "failed"
 *   8. FIX: garbage_bin expires_at 24h → 7 days
 *   9. FIX: "enrichment_failed" reason actually use হচ্ছে
 */

import { supabase }             from "../config/supabase.js";
import { buildVerifiedLeadRow } from "../lib/promoteLead.js";
import { runEnrichJob }         from "./enrichJob.js";
import { ENRICHMENT_COSTS }     from "@compx/scraper-core";

const MAX_ENRICH_ATTEMPTS = 3;
const GARBAGE_TTL_DAYS    = 7;

// FIX: runEnrichJob() (Hunter.io lookup, Serper website-discovery for
// no-website leads, page fetch) was never billed here — ENRICHMENT_COSTS
// .website_enrichment already existed for exactly this, it was just never
// wired up on this call site.
//
// Billing policy (confirmed): attempt-based, not success-only — Hunter/
// Serper/proxy cost is incurred whether or not an email is found, so a
// completed lookup with "no result" is billed the same as a successful
// one. The only free outcomes are genuine system failures (crash, timeout,
// proxy fail — nothing was actually completed) and domain-cooldown skips
// (nothing was scraped at all). Retries never stack charges — this lead
// has up to MAX_ENRICH_ATTEMPTS internal attempts, but they're one billing
// unit: charged exactly once, at whichever attempt reaches a terminal
// state (SUCCESS on email-found, or NO_RESULT once retries are exhausted).
// A mid-sequence "no email yet, will retry" outcome is not terminal and
// is not charged.
async function chargeEnrichAttempt(userId, orgId) {
  const amount = ENRICHMENT_COSTS.website_enrichment;
  try {
    await supabase.rpc("deduct_credits", {
      p_user_id: userId,
      p_org_id:  orgId || userId,
      p_amount:  amount,
    });
  } catch (err) {
    console.error("[PipelineFilter] Credit deduct error:", err.message);
  }
}

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

  if ((dbLead.enrich_attempts || 0) >= MAX_ENRICH_ATTEMPTS) {
    console.log(`[PipelineFilter] Max attempts (${MAX_ENRICH_ATTEMPTS}) reached → garbage`);
    return await dumpToGarbage(dbLead, orgId, userId, "max_attempts_reached");
  }

  // --- 1. Define Verification Profile & Taxonomy ---
  const MARKETPLACE_SOURCES = ["amazon", "ebay", "tripadvisor"];
  const SOCIAL_SOURCES = ["facebook", "instagram", "linkedin", "youtube"];
  
  dbLead.extra_data = dbLead.extra_data || {};
  dbLead.extra_data.verification = {
    platform: MARKETPLACE_SOURCES.includes(dbLead.source) || SOCIAL_SOURCES.includes(dbLead.source) || !!dbLead.source,
    company: false,
    website: !!dbLead.website,
    email: !!dbLead.email,
    phone: !!dbLead.phone
  };

  // --- 2. Has Email → Direct Promote ---
  if (dbLead.email) {
    console.log(`[PipelineFilter] Has email → checking duplicate then promoting`);
    dbLead.pipeline_status = "enriched";
    return await promoteToLeads(dbLead, orgId);
  }

  // --- 3. Has Website → Full Enrichment ---
  if (dbLead.website) {
    console.log(`[PipelineFilter] Has website, no email → enriching`);
    return await enrichAndDecide(dbLead, billUser, orgId);
  }

  // --- 4. Company Resolution (P2 Entry for Marketplace) ---
  if (MARKETPLACE_SOURCES.includes(dbLead.source)) {
    console.log(`[PipelineFilter] Marketplace Lead (${dbLead.source}) without website → Resolving Company`);
    // FIX: for marketplace leads (Amazon in particular), dbLead.company is
    // often just the product title ("Men's Lite Racer Adapt 7.0 Running
    // Shoes"), not a real company/brand name — querying Serper with that
    // text returns unrelated pages, which then burn a full enrichment
    // attempt (Hunter/pattern lookup against a domain that has nothing to
    // do with the actual seller) before landing in garbage_bin as
    // "enrichment_failed". Prefer the actual brand name when the scraper
    // captured one (extra_data.brand) — falls back to the old behavior
    // when it isn't present, so this is additive, not a behavior change
    // for sources that never had a brand field.
    const resolutionQuery = dbLead.extra_data?.brand || dbLead.company || dbLead.name;
    const resolution = await resolveCompanyWebsite(resolutionQuery, dbLead.address);
    
    if (resolution && resolution.website) {
       console.log(`[PipelineFilter] Resolved website: ${resolution.website} (confidence: ${resolution.confidence})`);
       dbLead.website = resolution.website;
       dbLead.extra_data.verification.company = true;
       dbLead.extra_data.verification.website = true;
       dbLead.extra_data.resolution_confidence = resolution.confidence;
       
       // Update staging lead with new website so it's persisted (No Extra Credit Charged for resolution!)
       await supabase.from("leads_staging").update({ website: dbLead.website, extra_data: dbLead.extra_data }).eq("id", dbLead.id);
       
       return await enrichAndDecide(dbLead, billUser, orgId);
    } else {
       console.log(`[PipelineFilter] Unresolvable Marketplace Lead → promoting as marketplace_only`);
       dbLead.pipeline_status = "marketplace_only";
       dbLead.extra_data.resolution_confidence = 0;
       return await promoteToLeads(dbLead, orgId);
    }
  }

  // --- 5. Social Bypass ---
  if (SOCIAL_SOURCES.includes(dbLead.source)) {
    console.log(`[PipelineFilter] Social Lead (${dbLead.source}) without website → promoting as social_only`);
    dbLead.pipeline_status = "social_only";
    return await promoteToLeads(dbLead, orgId);
  }

  // --- 6. Google Maps with Phone Bypass ---
  if (dbLead.source === "google_maps" && dbLead.phone) {
    console.log(`[PipelineFilter] Google Maps Lead without website but has Phone → promoting as enriched`);
    dbLead.pipeline_status = "enriched";
    return await promoteToLeads(dbLead, orgId);
  }

  console.log(`[PipelineFilter] No website, no email, no valid bypass → garbage`);
  return await dumpToGarbage(dbLead, orgId, userId, "no_data");
}

// ── Company Resolution (0 Credits) ────────────────────────────────────────────
async function resolveCompanyWebsite(companyName, location) {
  if (!companyName) return null;
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return null;
  
  const q = location ? `${companyName} ${location}` : companyName;

  try {
    // 1. Try Google Maps Match (Places API) -> Confidence 80
    const placesRes = await fetch("https://google.serper.dev/places", {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q })
    });
    if (placesRes.ok) {
      const placesData = await placesRes.json();
      if (placesData.places && placesData.places.length > 0) {
        for (const place of placesData.places) {
          if (place.website) return { website: place.website, confidence: 80 };
        }
      }
    }

    // 2. Try Serper Search (Organic) -> Confidence 30
    const searchRes = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: companyName + " official website" })
    });
    if (searchRes.ok) {
      const searchData = await searchRes.json();
      if (searchData.organic && searchData.organic.length > 0) {
        for (const result of searchData.organic) {
          const link = result.link || "";
          if (!link.includes("amazon.") && !link.includes("ebay.") && !link.includes("tripadvisor.") && !link.includes("facebook.") && !link.includes("instagram.") && !link.includes("linkedin.")) {
            return { website: link, confidence: 30 };
          }
        }
      }
    }
  } catch (err) {
    console.error("[CompanyResolution] Error:", err.message);
  }
  return null;
}

// ── Enrich ────────────────────────────────────────────────────────────────────
async function enrichAndDecide(dbLead, userId, orgId) {
  // FIX: enrich_attempts is no longer incremented up front. A domain-cooldown
  // skip from enrichJob.js isn't a real attempt (nothing was actually
  // scraped) — see the check right after runEnrichJob() below. The counter
  // now only advances when an attempt genuinely happened (crashed or ran).
  const priorAttempts = dbLead.enrich_attempts || 0;

  await supabase
    .from("leads_enrichment_queue")
    .update({ status: "processing", updated_at: new Date().toISOString() })
    .eq("staging_id", dbLead.id);

  let enrichResult = null;

  try {
    enrichResult = await runEnrichJob(
      {
        website:     dbLead.website,
        name:        dbLead.company || dbLead.name,
        leadId:      null,
        targetTable: null,
        proxyUrl:    process.env.PROXY_URL || null,
      },
      userId
    );
  } catch (err) {
    console.error("[PipelineFilter] enrichJob threw:", err.message);
    const attempts = priorAttempts + 1;
    await supabase
      .from("leads_staging")
      .update({ enrich_attempts: attempts, updated_at: new Date().toISOString() })
      .eq("id", dbLead.id);

    // FIX 6: crash হলে queue "processing" এ আটকাবে না
    await supabase
      .from("leads_enrichment_queue")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("staging_id", dbLead.id);

    // FIX 7: retry আছে কিনা দেখো
    const isLastAttempt = attempts >= MAX_ENRICH_ATTEMPTS;
    await supabase
      .from("leads_staging")
      .update({
        status:     isLastAttempt ? "failed" : "pending",
        updated_at: new Date().toISOString(),
      })
      .eq("id", dbLead.id);

    if (isLastAttempt) {
      return await dumpToGarbage(dbLead, orgId, userId, "enrichment_failed");
    }

    return { kept: true, reason: "enrichJob_crashed", attempt: attempts };
  }

  // FIX: a domain-cooldown collision is not a failed enrichment — nothing was
  // actually scraped, so it must not burn down enrich_attempts or eventually
  // land in garbage_bin. Requeue as "pending" with the attempts counter
  // untouched so the next pickup gets a real try.
  if (enrichResult?.skipped) {
    console.log(
      `[PipelineFilter] Enrich skipped (${enrichResult.reason}) for ` +
      `${dbLead.company || dbLead.name} — requeueing, not counted as an attempt`
    );
    await supabase
      .from("leads_enrichment_queue")
      .update({ status: "pending", updated_at: new Date().toISOString() })
      .eq("staging_id", dbLead.id);
    await supabase
      .from("leads_staging")
      .update({ status: "pending", updated_at: new Date().toISOString() })
      .eq("id", dbLead.id);
    return { kept: true, reason: `enrich_skipped_${enrichResult.reason || "unknown"}`, attempt: priorAttempts };
  }

  const attempts = priorAttempts + 1;
  await supabase
    .from("leads_staging")
    .update({ enrich_attempts: attempts, updated_at: new Date().toISOString() })
    .eq("id", dbLead.id);

  const email            = enrichResult?.work_email || enrichResult?.emails?.[0] || null;
  const phone            = enrichResult?.phones?.[0] || null;
  const techStack        = enrichResult?.techStack   || [];
  const hunterUsed       = enrichResult?.hunterUsed  || false;
  const patternPredicted = enrichResult?.patternPredicted || false;

  const socialLinks = {
    ...(dbLead.social_links || {}),
    ...(enrichResult?.social_links || {}),
    ...(enrichResult?.socials      || {}),
  };

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
    console.log(`[PipelineFilter] No email found → staging (attempt ${attempts}/${MAX_ENRICH_ATTEMPTS})`);

    const isLastAttempt = attempts >= MAX_ENRICH_ATTEMPTS;

    // FIX: charge here ONLY on the last attempt — this is the point where
    // the lead's enrichment lifecycle reaches its terminal NO_RESULT state.
    // Attempts 1 and 2 (kept: true, will retry) are mid-sequence and not
    // billed — otherwise a lead needing all 3 attempts would be charged 3x
    // for what the user experiences as one enrichment job.
    if (isLastAttempt && !enrichResult?.error) {
      await chargeEnrichAttempt(userId, orgId);
    }

    await supabase
      .from("leads_staging")
      .update({
        // FIX 7: শেষ attempt না হলে "pending" রাখো যাতে retry হয়
        status:       isLastAttempt ? "failed" : "pending",
        phone:        phone        || dbLead.phone,
        social_links: socialLinks,
        tech_stack:   techStack,
        linkedin_url: linkedin     || dbLead.linkedin_url || null,
        updated_at:   new Date().toISOString(),
      })
      .eq("id", dbLead.id);

    await supabase
      .from("leads_enrichment_queue")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("staging_id", dbLead.id);

    // FIX 9: শেষ attempt এ garbage তে পাঠাও
    if (isLastAttempt) {
      return await dumpToGarbage(dbLead, orgId, userId, "enrichment_failed");
    }

    return { kept: true, reason: "no_email_but_has_website", attempt: attempts };
  }

  // FIX 2: Pattern email → score penalty
  let score = dbLead.score || 0;
  if (patternPredicted) {
    score = Math.max(0, score - 15);
    console.log(`[PipelineFilter] Pattern predicted email: ${email} — promoting with low confidence (score -15 → ${score})`);
  }
  if (hunterUsed) {
    console.log(`[PipelineFilter] Hunter.io email: ${email} — promoting`);
  }

  const enrichedLead = {
    ...dbLead,
    email,
    score,
    phone:        phone     || dbLead.phone,
    social_links: socialLinks,
    tech_stack:   techStack,
    linkedin_url: linkedin  || dbLead.linkedin_url || null,
    email_source: patternPredicted ? "pattern" : hunterUsed ? "hunter" : "scrape",
    // FIX: pipeline_status was never set on this path — buildVerifiedLeadRow()
    // falls back to 'new' when it's missing, so leads that went through
    // full website enrichment and found an email were silently recorded as
    // pipeline_status: 'new' in leads_verified, same as a lead that never
    // touched the pipeline at all. Breaks any reporting/filtering on
    // pipeline_status (e.g. "how many leads came from enrichment vs a
    // direct email hit").
    pipeline_status: "enriched",
  };

  // FIX: charge on this terminal SUCCESS state. Charged once, regardless of
  // which attempt number found the email — earlier attempts (if any) were
  // mid-sequence "no email yet" outcomes and were not charged.
  await chargeEnrichAttempt(userId, orgId);

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
      // FIX 8: 24h → 7 days
      expires_at:   new Date(Date.now() + GARBAGE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
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
    enrichment_failed:    `"${dbLead.company || dbLead.name}" enrichment found no email after ${MAX_ENRICH_ATTEMPTS} attempts — moved to garbage.`,
    email_invalid:        `"${dbLead.company || dbLead.name}" email was invalid — moved to garbage.`,
    max_attempts_reached: `"${dbLead.company || dbLead.name}" enrichment failed after ${MAX_ENRICH_ATTEMPTS} attempts — moved to garbage.`,
    enrichJob_crashed:    `"${dbLead.company || dbLead.name}" enrichment crashed — moved to garbage.`,
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
