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

const SOCIAL_DOMAINS = [
  "facebook.com", "instagram.com", "twitter.com", "x.com",
  "linkedin.com", "youtube.com", "tiktok.com", "pinterest.com",
  "snapchat.com", "threads.net", "t.me", "wa.me",
];

function normalizeWebsite(raw) {
  if (!raw) return null;
  let url = raw.trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const parsed = new URL(url);
    // Social media URL কে website হিসেবে save করবো না
    const isSocial = SOCIAL_DOMAINS.some(d => parsed.hostname.includes(d));
    if (isSocial) return null;
    return parsed.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function buildSocialLinks(item) {
  const links = { ...(item.social_links || {}) };

  if (item.linkedin)    links.linkedin    = item.linkedin;
  if (item.twitter)     links.twitter     = item.twitter;
  if (item.channelUrl)  links.youtube     = item.channelUrl;
  if (item.crunchbase)  links.crunchbase  = item.crunchbase;
  if (item.facebook)    links.facebook    = item.facebook;
  if (item.tiktok)      links.tiktok      = item.tiktok;

  // Google Maps
  if (item.placeId) {
    links.google_maps = `https://www.google.com/maps/place/?q=place_id:${item.placeId}`;
  }

  // Instagram — handle বা profileUrl
  if (item.instagram) {
    links.instagram = item.instagram;
  } else if (item.profileUrl && !links.instagram) {
    links.instagram = item.profileUrl;
  }

  // YouTube channel এ social links আসে (instagram, twitter)
  if (item.source === "youtube") {
    if (item.instagram && !links.instagram) links.instagram = item.instagram;
    if (item.twitter   && !links.twitter)   links.twitter   = item.twitter;
    if (item.facebook  && !links.facebook)  links.facebook  = item.facebook;
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

  // YouTube — raw column এ proper data দাও যাতে modal ঠিকমতো দেখায়
  if (source === "youtube") {
    row.meta_description = item.description || null;
    row.followers_count  = item.subscriberCount ? parseInt(item.subscriberCount) : null;
    row.raw = {
      ...item,
      // normalize field names — leadRawNormalize.ts এ এগুলো দিয়ে detect হয়
      source:           "youtube",
      channel_name:     item.channelName     || item.name    || null,
      subscriber_count: item.subscriberCount || item.subscriber_count || "0",
      total_video_count: item.videoCount     || item.total_video_count || "0",
      view_count:       item.viewCount       || item.view_count || "0",
      channel_created_at: item.joinedDate    || item.channel_created_at || null,
      country:          item.country         || null,
      description:      item.description     || null,
      channelUrl:       item.channelUrl      || null,
    };
  }

  // Instagram — raw column এ proper data
  if (source === "instagram" || source === "instagram_biz") {
    row.meta_description = item.bio || null;
    row.followers_count  = item.followersCount || item.follower_count || null;
    row.raw = {
      ...item,
      source:          source,
      username:        item.username         || item.handle        || null,
      follower_count:  item.followersCount   || item.follower_count || 0,
      following_count: item.followsCount     || item.following_count || 0,
      post_count:      item.postsCount       || item.post_count    || 0,
      is_verified:     item.isVerified       || item.is_verified   || false,
      account_type:    item.accountType      || item.account_type  || null,
      bio:             item.bio              || null,
    };
  }

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
