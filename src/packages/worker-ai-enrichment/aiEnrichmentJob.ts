/**
 * workers/ai-enrichment/aiEnrichmentJob.ts
 *
 * Phase 14: "Worker finish → AI Queue → Industry / Category / Keywords /
 * Company Summary / Lead Score". Did not exist in the old codebase at all
 * — pipelineFilterJob.js promoted leads with only tech_stack/social/email
 * data, no AI-derived fields.
 *
 * Runs as its own BullMQ queue/worker (`ai-enrichment`), fed by the main
 * dispatcher after a lead is promoted to leads_verified (see the "chain"
 * note at the bottom of this file for the one-line hook into
 * pipelineFilterJob.js's promoteToLeads()).
 */

import { SupabaseClient } from "@supabase/supabase-js";

export interface AiEnrichmentInput {
  leadId: string;
  company: string | null;
  website: string | null;
  bio?: string | null;
  metaDescription?: string | null;
}

export interface AiEnrichmentResult {
  industry: string | null;
  category: string | null;
  keywords: string[];
  companySummary: string | null;
  leadScore: number; // 0-100
}

const ANTHROPIC_MODEL = "claude-sonnet-4-6";

async function callAnthropic(prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) throw new Error(`Anthropic API returned ${res.status}`);
  const data = await res.json();
  const text = data.content?.find((c: any) => c.type === "text")?.text;
  if (!text) throw new Error("No text content in Anthropic response");
  return text;
}

function buildPrompt(input: AiEnrichmentInput): string {
  return `You are a B2B lead-qualification assistant. Given this company data, respond ONLY with a JSON object — no preamble, no markdown fences.

Company: ${input.company || "unknown"}
Website: ${input.website || "none"}
Bio/description: ${input.bio || input.metaDescription || "none"}

Return exactly this shape:
{
  "industry": "<one or two word industry, or null>",
  "category": "<specific business category, or null>",
  "keywords": ["<up to 5 relevant keywords>"],
  "companySummary": "<one sentence, under 25 words, or null>",
  "leadScore": <integer 0-100 estimating B2B outreach fit based on data completeness and signal quality>
}`;
}

function safeParseJson(text: string): AiEnrichmentResult | null {
  try {
    const cleaned = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      industry: parsed.industry ?? null,
      category: parsed.category ?? null,
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 5) : [],
      companySummary: parsed.companySummary ?? null,
      leadScore: typeof parsed.leadScore === "number" ? Math.max(0, Math.min(100, parsed.leadScore)) : 0,
    };
  } catch {
    return null;
  }
}

/** Deterministic fallback when the AI call fails or ANTHROPIC_API_KEY is unset — never blocks the pipeline on an LLM outage. */
function heuristicFallback(input: AiEnrichmentInput): AiEnrichmentResult {
  const hasWebsite = !!input.website;
  const hasBio = !!(input.bio || input.metaDescription);
  return {
    industry: null,
    category: null,
    keywords: [],
    companySummary: null,
    leadScore: (hasWebsite ? 40 : 0) + (hasBio ? 20 : 0) + (input.company ? 20 : 0),
  };
}

export async function runAiEnrichment(
  input: AiEnrichmentInput,
  supabase: SupabaseClient
): Promise<AiEnrichmentResult> {
  let result: AiEnrichmentResult;

  try {
    const text = await callAnthropic(buildPrompt(input));
    result = safeParseJson(text) ?? heuristicFallback(input);
  } catch (err: any) {
    console.warn(`[AiEnrichment] LLM call failed for lead ${input.leadId}, using heuristic fallback:`, err.message);
    result = heuristicFallback(input);
  }

  await supabase
    .from("leads_verified")
    .update({
      industry: result.industry,
      category: result.category,
      ai_keywords: result.keywords,
      company_summary: result.companySummary,
      lead_score: result.leadScore,
      ai_enriched_at: new Date().toISOString(),
    })
    .eq("id", input.leadId);

  return result;
}

/**
 * CHAIN HOOK — one addition needed in pipelineFilterJob.js's promoteToLeads(),
 * right after the successful leads_verified insert:
 *
 *   await aiEnrichmentQueue.add("ai_enrich", {
 *     leadId: dbLead.id,
 *     company: dbLead.company,
 *     website: dbLead.website,
 *     bio: dbLead.raw?.bio,
 *     metaDescription: dbLead.meta_description,
 *   });
 *
 * Kept as a queued job (not inline) so a slow/failed LLM call never blocks
 * or fails the lead promotion itself.
 */
