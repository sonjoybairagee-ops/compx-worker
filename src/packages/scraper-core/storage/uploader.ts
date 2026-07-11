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
}

const BATCH_SIZE = 50;

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

export async function saveLeads<T = any>(
  supabase: AnySupabase,
  results: T[],
  userId: string,
  orgId: string | null,
  mapRow: RowMapper<T>
): Promise<UploadResult> {
  if (!results?.length) return { saved: 0, errors: 0, savedIds: [] };

  const rows = results.map((item) => mapRow(item, userId, orgId));
  const withWebsite = rows.filter((r) => r.website);
  const withoutWebsite = rows.filter((r) => !r.website);

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

  console.log(`[Uploader] Saved ${saved}/${results.length} leads (${errors} errors)`);
  return { saved, errors, savedIds };
}
