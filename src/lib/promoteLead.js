/** Mirror of src/lib/leads/leadRawNormalize.ts for worker promote inserts */

function enrichRawForStorage(raw = {}) {
  const source = String(raw.source ?? "").toLowerCase();
  const out = { ...raw };

  if (source.includes("youtube") || raw.subscriberCount != null) {
    out.channel_name = raw.channel_name ?? raw.name ?? raw.company;
    out.subscriber_count = raw.subscriber_count ?? raw.subscriberCount;
    out.total_video_count = raw.total_video_count ?? raw.videoCount;
    out.channel_created_at = raw.channel_created_at ?? raw.joinedDate;
  }
  if (source.includes("instagram") || raw.followersCount != null) {
    out.username = raw.username ?? raw.handle;
    out.follower_count = raw.follower_count ?? raw.followersCount;
    out.following_count = raw.following_count ?? raw.followsCount;
    out.post_count = raw.post_count ?? raw.postsCount;
    out.account_type = raw.account_type ?? raw.accountType;
    out.is_verified = raw.is_verified ?? raw.isVerified;
    out.location = raw.location ?? raw.igLocation ?? raw.address;
  }
  if (raw.isHiring != null && out.is_hiring == null) out.is_hiring = raw.isHiring;
  if (raw.contactName && !out.contact_name) out.contact_name = raw.contactName;
  if (raw.contactTitle && !out.contact_title) out.contact_title = raw.contactTitle;

  return out;
}

function isHiringFromRaw(raw = {}) {
  return !!(raw.isHiring ?? raw.is_hiring);
}

export function buildVerifiedLeadRow(lead) {
  const raw = enrichRawForStorage(lead.raw || {});
  const social = lead.social_links || {};
  const source = String(lead.source ?? raw.source ?? "").toLowerCase() || null;

  return {
    company_id: lead.company_id || lead.id,
    org_id: lead.org_id,
    score: lead.score || 0,
    status: "verified",
    company: lead.company || lead.name,
    name: lead.name || lead.company,
    industry: lead.industry || null,
    email: lead.email || null,
    phone: lead.phone || null,
    website: lead.website || null,
    address: lead.address || null,
    social_links: lead.social_links || null,
    contact_name: lead.contact_name || raw.contact_name || raw.contactName || null,
    contact_title: lead.contact_title || raw.contact_title || raw.contactTitle || null,
    hiring_signal: isHiringFromRaw(raw),
    source,
    linkedin_url: social.linkedin || raw.linkedin || raw.linkedin_url || null,
    timezone: lead.timezone || null,
    raw,
  };
}
