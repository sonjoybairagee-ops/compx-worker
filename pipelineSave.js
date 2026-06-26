/**
 * pipelineSave.js (FIXED)
 *
 * Fixes applied:
 *   1. Batch insert — N+1 DB call বন্ধ (প্রতি ৫০ row একসাথে)
 *   2. Upsert with onConflict — duplicate insert বন্ধ
 *   3. instagram social_links double-set bug fix
 */

import { supabase } from "../config/supabase.js";

const BATCH_SIZE = 50;

function normalizeWebsite(raw) {
  if (!raw) return null;
  let url = raw.trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    return new URL(url).href.replace(/\/$/, "");
  } catch {
    return url.split("/")[0] || null;
  }
}

function buildSocialLinks(item) {
  const links = { ...(item.social_links || {}) };
  if (item.linkedin)   links.linkedin   = item.linkedin;
  if (item.twitter)    links.twitter    = item.twitter;
  if (item.channelUrl) links.youtube    = item.channelUrl;
  if (item.crunchbase) links.crunchbase = item.crunchbase;
  if (item.placeId)    links.google_maps = `https://www.google.com/maps/place/?q=place_id:${item.placeId}`;

  // FIX 3: instagram double-set bug
  // আগে: item.instagram ও item.profileUrl দুটোই set করত — profileUrl overwrite করত
  if (item.instagram) {
    links.instagram = item.instagram;
  } else if (item.profileUrl) {
    links.instagram = item.profileUrl; // fallback, instagram handle না থাকলে
  }

  return Object.keys(links).length > 0 ? links : null;
}

function buildRow(item, userId, orgId, source) {
  let website = normalizeWebsite(item.website || item.domain);
  if (!website && item.crunchbase) website = normalizeWebsite(item.crunchbase);

  const company = item.company || item.name || item.title || null;

  const row = {
    org_id:   orgId,
    user_id:  userId,
    name:     item.name || item.contactName || company,
    company,
    industry: item.industry || item.category || null,
    website,
    address:  item.address || item.location || null,
    source,
    raw:      item,
    status:   "pending",
    score:    item.score ?? 0,
  };

  if (item.email)        row.email         = item.email;
  if (item.phone)        row.phone         = item.phone;
  if (item.contactName)  row.contact_name  = item.contactName;
  if (item.contactTitle) row.contact_title = item.contactTitle;

  const social = buildSocialLinks(item);
  if (social) row.social_links = social;

  return row;
}

export async function saveToDatabaseLeads(results, userId, orgId, source = "discover") {
  if (!results?.length) return { saved: 0, errors: 0 };

  // FIX 1: সব row আগে build করুন
  const rows = results.map(item => buildRow(item, userId, orgId, source));

  let saved  = 0;
  let errors = 0;

  // FIX 1: Batch এ insert — প্রতি ৫০ row একসাথে
  // আগে: প্রতি row এ আলাদা await → 100 lead = 100 DB call
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    // FIX 2: upsert দিয়ে duplicate prevent করুন
    // onConflict: org_id + website — same org এ same website duplicate হবে না
    // DB তে এই unique constraint থাকতে হবে:
    //   UNIQUE (org_id, website) WHERE website IS NOT NULL
    const { data, error } = await supabase
      .from("leads_staging")
      .upsert(batch, {
        onConflict:       "org_id,website",
        ignoreDuplicates: true,  // duplicate হলে skip, error না
      })
      .select("id");

    if (error) {
      console.error(`[pipelineSave] Batch ${i / BATCH_SIZE + 1} error:`, error.message);
      errors += batch.length;
      continue;
    }

    saved += data?.length ?? batch.length;
  }

  console.log(`[pipelineSave] Saved ${saved}/${results.length} to leads_staging (${errors} errors)`);
  return { saved, errors };
}
