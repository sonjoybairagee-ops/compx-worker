/**
 * pipelineSave.js (FIXED v2)
 *
 * Fixes applied:
 *   1. Batch insert — N+1 DB call বন্ধ (প্রতি ৫০ row একসাথে)
 *   2. Upsert with onConflict — duplicate insert বন্ধ
 *   3. instagram social_links double-set bug fix
 *   4. linkedin_url column populate করা হয়েছে
 *   5. amazon.com SOCIAL_DOMAINS এ যোগ করা হয়েছে (Amazon URL website হিসেবে save হবে না)
 *   6. website null leads → plain insert (upsert এ NULL conflict হয় না)
 *   7. extra_data → Amazon/YouTube platform-specific data
 *   8. email_source → hunter/pattern/firecrawl track করা হচ্ছে
 */

import { supabase } from "../config/supabase.js";

const BATCH_SIZE = 50;

const SOCIAL_DOMAINS = [
  "facebook.com", "instagram.com", "twitter.com", "x.com",
  "linkedin.com", "youtube.com", "tiktok.com", "pinterest.com",
  "snapchat.com", "threads.net", "t.me", "wa.me",
  "amazon.com", // FIX 5: Amazon product URL website হিসেবে save হবে না
];

function normalizeWebsite(raw) {
  if (!raw) return null;
  let url = raw.trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const parsed = new URL(url);
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

  // Amazon seller link
  if (item.source === "amazon" && item.sellerLink) {
    links.amazon_seller = item.sellerLink;
  }
  if (item.source === "amazon" && item.amazonUrl) {
    links.amazon_product = item.amazonUrl;
  }

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

  // YouTube channel এ social links আসে (instagram, twitter, facebook)
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
    // FIX: Postgres unique constraints never treat NULL = NULL as a match,
    // so onConflict("org_id,website") silently stopped deduping for any
    // org-less user (org_id was NULL for every one of their rows) — the
    // exact duplicate-prevention this file's FIX 2 was supposed to add.
    // Falling back to userId gives every org-less user a stable, non-null
    // conflict key of their own. This mirrors the same orgId||userId
    // fallback already used for credit deduction in discoverScrapeJob.js.
    org_id:   orgId || userId,
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

  // FIX: item.metaDescription and item.isHiring come from discoverScrapeJob's
  // website enrichment step and previously weren't mapped to any column at
  // all (isHiring) or only mapped for YouTube/Instagram (meta_description,
  // and even then from the wrong field — item.description/item.bio, not
  // item.metaDescription). Set the general fallback chain first; the
  // per-source blocks below only override it when they have something more
  // specific, instead of unconditionally overwriting it.
  if (item.metaDescription || item.description || item.bio) {
    row.meta_description = item.metaDescription || item.description || item.bio || null;
  }
  if (typeof item.isHiring === "boolean") row.is_hiring = item.isHiring;

  if (item.email)        row.email         = item.email;
  if (item.phone)        row.phone         = item.phone;
  if (item.contactName)  row.contact_name  = item.contactName;
  if (item.contactTitle) row.contact_title = item.contactTitle;

  // FIX 4: linkedin_url column populate
  if (item.linkedin)     row.linkedin_url  = item.linkedin;

  // FIX 8: email_source track করা
  if (item.emailSource)  row.email_source  = item.emailSource;
  else if (item.email) {
    // emailSource explicitly set না থাকলে guess করো
    if (item._emailFromHunter)  row.email_source = "hunter";
    else if (item._emailFromPattern) row.email_source = "pattern";
    else if (item._emailFromScrape)  row.email_source = "firecrawl";
  }

  // YouTube — raw + extra_data
  if (source === "youtube") {
    row.followers_count  = item.subscriberCount ? parseInt(item.subscriberCount) : null;
    row.raw = {
      ...item,
      source:            "youtube",
      channel_name:      item.channelName       || item.name    || null,
      subscriber_count:  item.subscriberCount   || item.subscriber_count || "0",
      total_video_count: item.videoCount        || item.total_video_count || "0",
      view_count:        item.viewCount         || item.view_count || "0",
      channel_created_at: item.joinedDate       || item.channel_created_at || null,
      country:           item.country           || null,
      description:       item.description       || null,
      channelUrl:        item.channelUrl        || null,
    };
    // FIX 7: extra_data
    row.extra_data = {
      channel_id:       item.channelId       || null,
      channel_url:      item.channelUrl      || null,
      subscriber_count: item.subscriberCount || "0",
      video_count:      item.videoCount      || "0",
      view_count:       item.viewCount       || "0",
      joined_date:      item.joinedDate      || null,
      country:          item.country         || null,
    };
  }

  // Instagram — raw + extra_data
  if (source === "instagram" || source === "instagram_biz") {
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
    row.extra_data = {
      username:        item.username        || null,
      handle:          item.handle          || null,
      profile_url:     item.profileUrl      || null,
      followers_count: item.followersCount  || 0,
      follows_count:   item.followsCount    || 0,
      posts_count:     item.postsCount      || 0,
      is_verified:     item.isVerified      || false,
      is_business:     item.isBusinessAccount || false,
      account_type:    item.accountType     || null,
    };
  }

  // FIX 7: Amazon — raw + extra_data
  if (source === "amazon") {
    row.raw = {
      ...item,
      source:         "amazon",
      product_title:  item.productTitle  || null,
      product_price:  item.productPrice  || null,
      product_rating: item.productRating || null,
      product_reviews: item.productReviews || null,
      asin:           item.asin          || null,
      amazon_url:     item.amazonUrl     || null,
      seller_name:    item.sellerName    || null,
      seller_link:    item.sellerLink    || null,
    };
    row.extra_data = {
      asin:            item.asin           || null,
      product_title:   item.productTitle   || null,
      product_price:   item.productPrice   || null,
      product_rating:  item.productRating  || null,
      product_reviews: item.productReviews || null,
      amazon_url:      item.amazonUrl      || null,
      seller_name:     item.sellerName     || null,
      seller_link:     item.sellerLink     || null,
      product_image:   item.productImage   || null,
    };
  }

  const social = buildSocialLinks(item);
  if (social) row.social_links = social;

  return row;
}

export async function saveToDatabaseLeads(results, userId, orgId, source = "discover") {
  if (!results?.length) return { saved: 0, errors: 0 };

  const rows = results.map(item => buildRow(item, userId, orgId, source));

  // FIX 6: website আছে এমন → upsert (duplicate prevention)
  //         website নেই এমন → plain insert (NULL conflict হয় না)
  const withWebsite    = rows.filter(r => r.website);
  const withoutWebsite = rows.filter(r => !r.website);

  let saved  = 0;
  let errors = 0;

  // website আছে — upsert in batches
  for (let i = 0; i < withWebsite.length; i += BATCH_SIZE) {
    const batch = withWebsite.slice(i, i + BATCH_SIZE);
    const { data, error } = await supabase
      .from("leads_staging")
      .upsert(batch, {
        onConflict:       "org_id,website",
        ignoreDuplicates: true,
      })
      .select("id");

    if (error) {
      console.error(`[pipelineSave] Upsert batch ${i / BATCH_SIZE + 1} error:`, error.message);
      errors += batch.length;
      continue;
    }
    saved += data?.length ?? batch.length;
  }

  // website নেই — plain insert in batches
  for (let i = 0; i < withoutWebsite.length; i += BATCH_SIZE) {
    const batch = withoutWebsite.slice(i, i + BATCH_SIZE);
    const { data, error } = await supabase
      .from("leads_staging")
      .insert(batch)
      .select("id");

    if (error) {
      console.error(`[pipelineSave] Insert batch ${i / BATCH_SIZE + 1} error:`, error.message);
      errors += batch.length;
      continue;
    }
    saved += data?.length ?? batch.length;
  }

  console.log(`[pipelineSave] Saved ${saved}/${results.length} to leads_staging (${errors} errors)`);
  return { saved, errors };
}
