/**
 * pipelineSave.js
 * worker/src/jobs/pipelineSave.js
 *
 * discoverScrapeJob এর শেষে এই function call করুন।
 * leads table এ সরাসরি না গিয়ে database_leads (staging) এ যাবে।
 * তারপর pipelineFilterJob চেক করবে কোনটা enrich দরকার।
 */

import { supabase } from "../config/supabase.js";
import { compxJobsQueue } from "../config/queueRegistry.ts";

/**
 * Save scraped results to database_leads (staging).
 * Call this instead of inserting directly to leads table.
 *
 * @param {Object[]} results  - Array of scraped company objects
 * @param {string}   userId
 * @param {string}   orgId
 * @param {string}   source   - 'google_maps' | 'linkedin' | etc.
 */
export async function saveToDatabaseLeads(results, userId, orgId, source = "discover") {
  if (!results?.length) return { saved: 0, errors: 0 };

  let saved = 0;
  let errors = 0;

  for (const item of results) {
    const website = normalizeWebsite(item.website || item.domain);

    // Build row — only save what we actually have
    const row = {
      org_id:   orgId,
      user_id:  userId,
      name:     item.name || item.title || null,
      company:  item.company || item.name || item.title || null,
      industry: item.industry || item.category || null,
      website:  website || null,
      address:  item.address || item.location || null,
      source,
      raw:      item,
      status:   "pending",
    };

    // If scraper already found email/phone, include them
    if (item.email)         row.email = item.email;
    if (item.phone)         row.phone = item.phone;
    if (item.social_links)  row.social_links = item.social_links;

    const { data, error } = await supabase
      .from("database_leads")
      .insert(row)
      .select("id")
      .single();

    if (error) {
      console.error("[pipelineSave] Insert error:", error.message, "row:", row.company);
      errors++;
      continue;
    }

    saved++;

    // Immediately trigger pipeline filter for this record
    await triggerPipelineFilter(data.id, orgId, userId);
  }

  console.log(`[pipelineSave] Saved ${saved}/${results.length} to database_leads (${errors} errors)`);
  return { saved, errors };
}

/**
 * Trigger pipeline filter job for a single database_lead.
 * This checks if enrichment is needed and routes accordingly.
 */
async function triggerPipelineFilter(dbLeadId, orgId, userId) {
  try {
    // Mark as enriching
    await supabase
      .from("database_leads")
      .update({ status: "enriching", updated_at: new Date().toISOString() })
      .eq("id", dbLeadId);

    // Queue the filter job (via BullMQ)
    await compxJobsQueue().add("pipeline_filter", {
      type: "pipeline_filter",
      user_id: userId,
      input_data: {
        dbLeadId,
        orgId,
        userId,
      }
    });
  } catch (err) {
    console.error("[pipelineSave] triggerPipelineFilter error:", err.message);
  }
}

function normalizeWebsite(raw) {
  if (!raw) return null;
  return raw.trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .toLowerCase();
}
