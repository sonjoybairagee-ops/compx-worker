/**
 * scraper-core/storage/uploader.ts
 *
 * Generalizes worker/jobs/pipelineSave.js::saveToDatabaseLeads(). 
 * Now each plugin supplies its own RowMapper, and this module only handles 
 * what's genuinely shared: batching, upsert-vs-insert routing, and error counting.
 *
 * FIX: added a garbage_bin dedup pass with proper sorting to prioritize 
 * recently garbaged leads, and added in-batch deduplication for website-less leads.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any; 
import { normalizeWebsite } from "../parser/domain.js";

export interface StagingRow {
  org_id: string;
  user_id: string;
  name: string | null;
  company: string | null;
  industry?: string | null;
  website: string | null;
  address?: string | null;
  source: string;
  raw: Record<string, any>;
  status: string;
  score: number;
  email?: string;
  phone?: string;
  contact_name?: string;
  contact_title?: string;
  linkedin_url?: string;
  email_source?: string;
  meta_description?: string;
  is_hiring?: boolean;
  social_links?: Record<string, string> | null;
  extra_data?: Record<string, any>;
  followers_count?: number | null;
  [key: string]: any;
}

export type RowMapper<T = any> = (item: T, userId: string, orgId: string | null) => StagingRow;

export interface UploadResult {
  saved: number;
  errors: number;
  savedIds: string[];
  skippedGarbage: number;
}

const BATCH_SIZE = 50;
const GARBAGE_FETCH_LIMIT = 5000;

/** A baseline mapper covering the fields every source shares. */
export function baseRowMapper(
  item: Record<string, any>,
  userId: string,
  orgId: string | null,
  source: string
): StagingRow {
  // Support both camelCase and snake_case from different plugins
  const website = normalizeWebsite(item.website || item.domain);
  const company = item.company || item.name || item.title || null;
  const contactName = item.contactName || item.contact_name || null;
  const contactTitle = item.contactTitle || item.contact_title || null;
  const linkedin = item.linkedin || item.linkedin_url || null;
  const emailSource = item.emailSource || item.email_source || null;

  let defaultScore = 0;
  if (website) defaultScore += 30;
  if (item.email) defaultScore += 40;
  if (item.phone) defaultScore += 20;
  if (company) defaultScore += 10;

  const row: StagingRow = {
    org_id: orgId || userId, 
    user_id: userId,
    name: item.name || contactName || company,
    company,
    industry: item.industry || item.category || null,
    website,
    address: item.address || item.location || null,
    source,
    raw: item,
    status: "pending",
    score: item.score ?? defaultScore,
  };

  if (item.metaDescription || item.description || item.bio) {
    row.meta_description = item.metaDescription || item.description || item.bio;
  }
  if (typeof item.isHiring === "boolean" || typeof item.is_hiring === "boolean") {
    row.is_hiring = item.isHiring ?? item.is_hiring;
  }
  if (item.email) row.email = item.email;
  if (item.phone) row.phone = item.phone;
  if (contactName) row.contact_name = contactName;
  if (contactTitle) row.contact_title = contactTitle;
  if (linkedin) row.linkedin_url = linkedin;
  if (emailSource) row.email_source = emailSource;

  return row;
}

function normalizeCompanyKey(name: string | null | undefined): string {
  return (name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Fetch this org's garbage_bin identities. 
 * FIX: Added ordering to prioritize recently garbaged leads.
 */
async function fetchGarbageIdentities(
  supabase: AnySupabase,
  orgId: string
): Promise<{ websites: Set<string>; companies: Set<string> }> {
  const websites = new Set<string>();
  const companies = new Set<string>();

  const { data, error } = await supabase
    .from("garbage_bin")
    .select("data")
    .eq("org_id", orgId)
    .eq("source_table", "leads_staging")
    .order("created_at", { ascending: false }) // ✅ FIX: Prioritize recent garbage
    .limit(GARBAGE_FETCH_LIMIT);

  if (error) {
    console.warn("[Uploader] garbage_bin dedup lookup failed — proceeding without it:", error.message);
    return { websites, companies };
  }

  for (const row of data || []) {
    const d = row?.data || {};
    const normalizedWebsite = normalizeWebsite(d.website);
    if (normalizedWebsite) websites.add(normalizedWebsite);
    
    const companyKey = normalizeCompanyKey(d.company || d.name);
    if (companyKey) companies.add(companyKey);
  }

  return { websites, companies };
}

export async function saveLeads<T = any>(
  supabase: AnySupabase,
  results: T[],
  userId: string,
  orgId: string | null,
  mapRow: RowMapper<T>
): Promise<UploadResult> {
  if (!results?.length) return { saved: 0, errors: 0, savedIds: [], skippedGarbage: 0 };

  const effectiveOrgId = orgId || userId;
  const rows = results.map((item) => mapRow(item, userId, orgId));

  const garbage = await fetchGarbageIdentities(supabase, effectiveOrgId);

  let skippedGarbage = 0;
  const liveRows = rows.filter((r) => {
    const isGarbaged = r.website
      ? garbage.websites.has(r.website)
      : garbage.companies.has(normalizeCompanyKey(r.company || r.name));
    if (isGarbaged) skippedGarbage++;
    return !isGarbaged;
  });

  if (skippedGarbage > 0) {
    console.log(`[Uploader] Skipped ${skippedGarbage} lead(s) already in garbage_bin for org ${effectiveOrgId}`);
  }

  const withWebsite = liveRows.filter((r) => r.website);
  
  // ✅ FIX: In-batch deduplication for leads WITHOUT a website to prevent duplicate inserts
  const withoutWebsiteRaw = liveRows.filter((r) => !r.website);
  const seenNoWebsite = new Set<string>();
  const withoutWebsite = withoutWebsiteRaw.filter((r) => {
    // Create a unique key based on source + email (or name if no email)
    const uniqueKey = `${r.source}|${(r.email || r.name || '').toLowerCase().trim()}`;
    if (seenNoWebsite.has(uniqueKey)) return false;
    seenNoWebsite.add(uniqueKey);
    return true;
  });

  let saved = 0;
  let errors = 0;
  const savedIds: string[] = [];

  // 1. Upsert leads WITH website
  for (let i = 0; i < withWebsite.length; i += BATCH_SIZE) {
    const batch = withWebsite.slice(i, i + BATCH_SIZE);
    const { data, error } = await supabase
      .from("leads_staging")
      .upsert(batch, { onConflict: "org_id,website", ignoreDuplicates: true })
      .select("id");

    if (error) {
      console.error(`[Uploader] Upsert batch ${i / BATCH_SIZE + 1} error:`, error.message);
      errors += batch.length;
      continue;
    }
    if (data) {
      savedIds.push(...data.map((r: any) => r.id));
      saved += data.length;
    }
  }

  // 2. Insert leads WITHOUT website (deduped in-memory above)
  for (let i = 0; i < withoutWebsite.length; i += BATCH_SIZE) {
    const batch = withoutWebsite.slice(i, i + BATCH_SIZE);
    const { data, error } = await supabase.from("leads_staging").insert(batch).select("id");

    if (error) {
      console.error(`[Uploader] Insert batch ${i / BATCH_SIZE + 1} error:`, error.message);
      errors += batch.length;
      continue;
    }
    if (data) {
      savedIds.push(...data.map((r: any) => r.id));
      saved += data.length;
    }
  }

  console.log(`[Uploader] Saved ${saved}/${results.length} leads (${errors} errors, ${skippedGarbage} skipped as already-garbaged)`);
  return { saved, errors, savedIds, skippedGarbage };
}