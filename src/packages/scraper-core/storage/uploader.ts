/**
 * scraper-core/storage/uploader.ts
 *
 * Generalizes worker/jobs/pipelineSave.js::saveToDatabaseLeads(). The old
 * version had per-platform `if (source === "youtube") {...} if (source ===
 * "instagram") {...}` blocks baked directly into the save function — adding
 * a new source (Facebook Pages, TikTok, etc., per the roadmap's stated goal)
 * meant editing this shared file. Now each plugin supplies its own
 * `RowMapper`, and this module only handles what's genuinely shared: batching,
 * upsert-vs-insert routing (website-present vs website-absent, keeping the
 * org_id||user_id NULL-conflict fix from the original), and error counting.
 *
 * FIX: added a garbage_bin dedup pass. Previously, a lead the user
 * manually (or Smart Clean Up) sent to garbage_bin would silently
 * reappear as a brand-new leads_staging row the next time the same
 * source/keyword was scraped — the website-based upsert only prevents
 * duplicates against rows still LIVE in leads_staging, not ones that were
 * deleted after being garbaged, and website-less leads (common for
 * YouTube/Instagram, which usually have no linked website) had no dedup
 * at all, not even against leads_staging itself. This checks the org's
 * garbage_bin (by website when present, by normalized company/name when
 * not) before inserting, and skips anything that was already thrown out.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any; // Avoid cross-package @supabase version conflict
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

/** Plugin-supplied function: raw scraped item → a leads_staging row. */
export type RowMapper<T = any> = (item: T, userId: string, orgId: string | null) => StagingRow;

export interface UploadResult {
  saved: number;
  errors: number;
  /** DB-generated UUIDs of every row actually inserted/upserted into leads_staging. */
  savedIds: string[];
  /** Rows skipped because they match something already in this org's garbage_bin. */
  skippedGarbage: number;
}

const BATCH_SIZE = 50;
/** Safety cap on the garbage_bin dedup fetch — see note in fetchGarbageIdentities(). */
const GARBAGE_FETCH_LIMIT = 5000;

/** A baseline mapper covering the fields every source shares (name/company/website/socials). Plugins can spread this and add platform-specific fields on top rather than reimplementing it. */
export function baseRowMapper(
  item: Record<string, any>,
  userId: string,
  orgId: string | null,
  source: string
): StagingRow {
  const website = normalizeWebsite(item.website || item.domain);
  const company = item.company || item.name || item.title || null;

  let defaultScore = 0;
  if (website) defaultScore += 30;
  if (item.email) defaultScore += 40;
  if (item.phone) defaultScore += 20;
  if (company) defaultScore += 10;

  const row: StagingRow = {
    org_id: orgId || userId, // never null — see validator.ts::buildDedupKey
    user_id: userId,
    name: item.name || item.contactName || company,
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
  if (typeof item.isHiring === "boolean") row.is_hiring = item.isHiring;
  if (item.email) row.email = item.email;
  if (item.phone) row.phone = item.phone;
  if (item.contactName) row.contact_name = item.contactName;
  if (item.contactTitle) row.contact_title = item.contactTitle;
  if (item.linkedin) row.linkedin_url = item.linkedin;
  if (item.emailSource) row.email_source = item.emailSource;

  return row;
}

function normalizeCompanyKey(name: string | null | undefined): string {
  return (name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Fetch this org's garbage_bin identities (website + normalized company
 * name) for leads_staging-sourced entries, so saveLeads can skip
 * re-inserting anything already thrown out.
 *
 * NOTE: this pulls up to GARBAGE_FETCH_LIMIT rows per org per saveLeads()
 * call and builds the identity sets in memory (a jsonb `data->>field` path
 * isn't practical to batch-match via PostgREST's `.in()` — the simplest
 * robust option is fetching and filtering in JS). garbage_bin rows expire
 * after 30 days, so this stays naturally bounded, but if a single org
 * generates a very high garbage volume this could get slow — add a
 * dedicated (org_id, source_table) index and/or narrow the time window
 * (e.g. `.gte("created_at", ...)`) if that happens.
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
  const withoutWebsite = liveRows.filter((r) => !r.website);

  let saved = 0;
  let errors = 0;
  const savedIds: string[] = [];

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
