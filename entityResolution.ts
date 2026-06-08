// ─── Entity Resolution ─────────────────────────────────────────────────────────
// SHA-256 fingerprint দিয়ে duplicate company detect করে merge করে।

import crypto from 'crypto';
import { supabase } from './config/supabase.js'; // ← Fixed: db.ts এর বদলে config থেকে

export interface ResolvedLead {
  companyId?: string;
  entityHash: string;
  isNew: boolean;
  [key: string]: any;
}

export async function resolveEntity(lead: any): Promise<ResolvedLead> {
  const namePart   = (lead.name || '').toLowerCase().replace(/\s+/g, '');
  const domainPart = (lead.websiteDomain || '').toLowerCase();
  const hashInput  = `${namePart}|${domainPart}`;
  const entityHash = crypto.createHash('sha256').update(hashInput).digest('hex');

  // ── Check existing ─────────────────────────────────────────────────────────
  const { data: existing, error: lookupError } = await supabase
    .from('extension_database')      // companies table না থাকলে extension_database use করো
    .select('id, company_name, website, linkedin_url')
    .or(`website.eq.${lead.website},company_name.ilike.${lead.name}`)
    .limit(1)
    .maybeSingle();

  if (lookupError) {
    console.warn('[EntityResolution] Lookup error:', lookupError.message);
  }

  if (existing) {
    // ── Merge: নতুন fields যোগ করো যদি missing থাকে ────────────────────────
    const updates: Record<string, any> = {};
    if (!existing.website      && lead.website)      updates.website      = lead.website;
    if (!existing.linkedin_url && lead.linkedin_url) updates.linkedin_url = lead.linkedin_url;

    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString();
      const { error: updateError } = await supabase
        .from('extension_database')
        .update(updates)
        .eq('id', existing.id);

      if (updateError) {
        console.warn('[EntityResolution] Merge error:', updateError.message);
      } else {
        console.log(`[EntityResolution] Merged ${Object.keys(updates).length} field(s) into ${existing.id}`);
      }
    }

    return { ...lead, companyId: existing.id, entityHash, isNew: false };
  }

  return { ...lead, entityHash, isNew: true };
}
