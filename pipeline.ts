/**
 * CompX Worker — src/pipeline.ts
 *
 * Unified Enrichment Pipeline:
 *   normalize → entityResolution → enrich → signals → score → save
 *
 * এই ফাইলটি সব module কে একসাথে connect করে।
 * enrichJob.js এবং index.ts উভয়ই এখান থেকে call করবে।
 */

import { normalizeLead, type NormalizedLead }   from './normalize.js';
import { resolveEntity, type ResolvedLead }      from './entityResolution.js';
import { enrichLead, type EnrichedLead }         from './enrich.js';
import { detectSignals, summarizeSignals }        from './signals.js';
import { calculateScore, type ScoreResult }       from './score.js';
import { supabase }                               from './config/supabase.js';
import { appendLog }                              from './db.js';

export interface PipelineResult {
  lead:        NormalizedLead & ResolvedLead & EnrichedLead;
  signals:     ReturnType<typeof detectSignals>;
  score:       ScoreResult;
  savedToDb:   boolean;
  dbTable:     'leads' | 'extension_database' | null;
}

interface PipelineOptions {
  dbJobId?:   string;       // Supabase jobs table id — progress log এর জন্য
  orgId?:     string;
  userId:     string;
  sourceType?: 'discover' | 'extension' | 'scrape';
  leadId?:    string;       // existing extension_database row id
}

// ── Main Pipeline ─────────────────────────────────────────────────────────────
export async function runEnrichmentPipeline(
  rawLead: Record<string, any>,
  options: PipelineOptions
): Promise<PipelineResult> {
  const { dbJobId, orgId, userId, sourceType = 'scrape', leadId } = options;

  const log = async (msg: string) => {
    console.log(`[Pipeline] ${msg}`);
    if (dbJobId) await appendLog(dbJobId, `[${new Date().toLocaleTimeString()}] ${msg}`);
  };

  await log(`Starting pipeline for: ${rawLead.name || rawLead.company_name || rawLead.website}`);

  // ── Step 1: Normalize ────────────────────────────────────────────────────
  await log('Step 1/5: Normalizing lead data...');
  const normalized = normalizeLead({
    ...rawLead,
    name: rawLead.name || rawLead.company_name,
  });

  // ── Step 2: Entity Resolution (duplicate check) ──────────────────────────
  await log('Step 2/5: Resolving entity...');
  const resolved = await resolveEntity(normalized);

  if (!resolved.isNew) {
    await log(`Duplicate found — merging with existing company (${resolved.companyId})`);
  }

  // ── Step 3: Enrich (Crawlee website crawl) ───────────────────────────────
  await log(`Step 3/5: Enriching website: ${normalized.website || 'N/A'}...`);
  const enriched = await enrichLead(resolved);

  // ── Step 4: Signal Detection ─────────────────────────────────────────────
  await log('Step 4/5: Detecting signals...');
  const signals = detectSignals(enriched);
  await log(`Signals: ${summarizeSignals(signals)}`);

  // ── Step 5: Score ────────────────────────────────────────────────────────
  await log('Step 5/5: Calculating score...');
  const score = calculateScore(signals);
  await log(`Score: ${score.total}/100 — Status: ${score.status.toUpperCase()}`);

  // ── Save to Supabase ─────────────────────────────────────────────────────
  let savedToDb  = false;
  let dbTable: 'leads' | 'extension_database' | null = null;

  try {
    if (sourceType === 'discover') {
      // Discover/scrape → leads table (org-level)
      const minScore = 40;
      if (score.total >= minScore) {
        const row = {
          org_id:         orgId || userId,
          source:         rawLead.source || 'discover',
          company:        normalized.name || 'Unknown',
          name:           normalized.name,
          phone:          enriched.phones?.[0] || normalized.phone || null,
          email:          enriched.emails?.[0] || null,
          website:        normalized.website || null,
          industry:       normalized.industry || null,
          score:          score.total,
          lead_score:     score.total,
          intent_score:   score.intentScore,
          hiring_signal:  signals.intent.hiring,
          metadata: {
            enriched:    true,
            socials:     enriched.socials     || {},
            techStack:   enriched.techStack   || [],
            signals:     signals,
            scoreBreakdown: score.breakdown,
            isNew:       resolved.isNew,
          },
          created_at: new Date().toISOString(),
        };

        const { error } = await supabase.from('leads').insert(row);
        if (error) throw error;

        dbTable  = 'leads';
        savedToDb = true;
        await log(`✅ Saved to leads table (score: ${score.total})`);
      } else {
        await log(`⚠️ Score too low (${score.total} < ${minScore}). Skipped.`);
      }
    } else {
      // Extension → extension_database (user-level)
      const updateData = {
        email:            enriched.emails?.[0] || enriched.inferredEmails?.[0] || null,
        work_email:       enriched.work_email  || null,
        personal_email:   enriched.personal_email || null,
        phone:            enriched.phones?.[0] || normalized.phone || null,
        description:      enriched.metaDescription || null,
        linkedin_url:     enriched.socials?.linkedin || normalized.linkedin_url || null,
        phone_found:      signals.enrichment.phoneFound,
        linkedin_matched: signals.enrichment.linkedinFound,
        crm_ready:        score.total >= 60,
        score:            score.total,
        email_verified:   null,
      };

      if (leadId) {
        // Update existing row
        const { error } = await supabase
          .from('extension_database')
          .update(updateData)
          .eq('id', leadId)
          .eq('user_id', userId);
        if (error) throw error;
      } else {
        // Insert new row
        const { error } = await supabase
          .from('extension_database')
          .insert({ ...updateData, user_id: userId, company_name: normalized.name, source: rawLead.source || 'enriched' });
        if (error) throw error;
      }

      dbTable   = 'extension_database';
      savedToDb  = true;
      await log(`✅ Saved to extension_database (CRM ready: ${updateData.crm_ready})`);
    }
  } catch (err: any) {
    await log(`❌ DB save error: ${err.message}`);
    console.error('[Pipeline] DB error:', err);
  }

  return {
    lead:      enriched,
    signals,
    score,
    savedToDb,
    dbTable,
  };
}

// ── Batch Pipeline ────────────────────────────────────────────────────────────
// একসাথে অনেক lead process করার জন্য (scrape job এর পরে)
export async function runBatchPipeline(
  leads: Record<string, any>[],
  options: PipelineOptions
): Promise<{ processed: number; saved: number; results: PipelineResult[] }> {
  const results: PipelineResult[] = [];
  let saved = 0;

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    try {
      if (options.dbJobId) {
        await appendLog(
          options.dbJobId,
          `[${new Date().toLocaleTimeString()}] Processing lead ${i + 1}/${leads.length}: ${lead.name || lead.company_name}`
        );
      }

      const result = await runEnrichmentPipeline(lead, options);
      results.push(result);
      if (result.savedToDb) saved++;

      // Rate limit — Crawlee এর জন্য ছোট pause
      await new Promise(r => setTimeout(r, 500));
    } catch (err: any) {
      console.error(`[Pipeline] Lead ${i + 1} failed:`, err.message);
    }
  }

  return { processed: leads.length, saved, results };
}
