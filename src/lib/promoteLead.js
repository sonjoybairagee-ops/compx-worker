/**
 * lib/promoteLead.js
 *
 * Referenced by jobs/pipelineFilterJob.js (buildVerifiedLeadRow) but wasn't
 * part of the files originally shared — reconstructed here from how
 * pipelineFilterJob.js calls it: `buildVerifiedLeadRow({ ...dbLead, org_id })`.
 * Maps a leads_staging row (+ any enrichment fields merged onto it) into the
 * shape leads_verified expects.
 */

export function buildVerifiedLeadRow(dbLead) {
  return {
    org_id: dbLead.org_id,
    user_id: dbLead.user_id,
    name: dbLead.name || dbLead.contact_name || null,
    company: dbLead.company || null,
    industry: dbLead.industry || null,
    website: dbLead.website || null,
    address: dbLead.address || null,
    email: dbLead.email || null,
    phone: dbLead.phone || null,
    contact_name: dbLead.contact_name || null,
    contact_title: dbLead.contact_title || null,
    linkedin_url: dbLead.linkedin_url || null,
    email_source: dbLead.email_source || null,
    source: dbLead.source || null,
    tech_stack: dbLead.tech_stack || [],
    social_links: dbLead.social_links || null,
    meta_description: dbLead.meta_description || null,
    is_hiring: dbLead.is_hiring ?? null,
    score: dbLead.score ?? 0,
    raw: dbLead.raw || null,
    extra_data: dbLead.extra_data || null,
    staging_id: dbLead.id,
    pipeline_status: dbLead.pipeline_status || 'new',
    created_at: new Date().toISOString(),
  };
}
