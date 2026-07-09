import { fetchPage, getBrowserPool, getProxyManager, analyzeJobRisk, chargeBatchForLeads, checkCircuitBreaker, recordFailure, recordSuccess, CIRCUIT_BREAKER_CONFIG } from "@compx/scraper-core";
import { supabase } from "../config/supabase.js";
import * as cheerio from "cheerio";
import { DelayedError } from "bullmq";
import Redis from "ioredis";
import { URL } from "url";

// Constants for AI & Rules
const AI_CONFIG = {
  review_model: "gpt-4o-mini",
};
const OPPORTUNITY_SCORE_WEIGHTS = {
  rating: 30,
  sentiment: 30,
  website: 15,
  reviews: 15,
  ownerReplies: 10
};
const ALLOWED_BUYING_SIGNALS = [
  "Needs CRM", "Needs Website", "Needs SEO", "Needs Reputation Management", 
  "Needs Booking System", "Needs Automation", "Needs Social Media", 
  "Needs Chatbot", "Needs Review Management", "Needs Email Marketing", 
  "Needs Google Ads", "Needs Facebook Ads"
];

// Enums & Types
export enum TripadvisorStatus {
  FOUND = "FOUND",
  NOT_FOUND = "NOT_FOUND",
  PRIVATE = "PRIVATE",
  LOW_CONFIDENCE = "LOW_CONFIDENCE",
  ERROR_RETRYABLE = "ERROR_RETRYABLE",
  ERROR_FINAL = "ERROR_FINAL",
  INSUFFICIENT_DATA = "INSUFFICIENT_DATA"
}

interface AnalysisTrace {
  url_resolved: boolean;
  confidence: number;
  ai_ran: boolean;
  skip_reason: string | null;
}

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

// --- Helper Functions ---

// Simple Levenshtein distance for fuzzy matching
function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[a.length][b.length];
}

function calculateConfidence(dbName: string, dbAddress: string, scrapedName: string, scrapedAddress: string): number {
  const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, '');
  const nDbName = norm(dbName);
  const nScrapeName = norm(scrapedName);
  const nDbAddr = norm(dbAddress);
  const nScrapeAddr = norm(scrapedAddress);

  if (!nDbName || !nScrapeName) return 0;
  
  const nameDist = levenshtein(nDbName, nScrapeName);
  const nameScore = Math.max(0, 1 - nameDist / Math.max(nDbName.length, nScrapeName.length));

  let addrScore = 0.5; // default if no address to compare
  if (nDbAddr && nScrapeAddr) {
    const addrDist = levenshtein(nDbAddr, nScrapeAddr);
    addrScore = Math.max(0, 1 - addrDist / Math.max(nDbAddr.length, nScrapeAddr.length));
    
    // Sometimes address includes state/zip codes that cause low strict levenshtein.
    // Token matching for address is better:
    const dbTokens = nDbAddr.split(/\s+/);
    const scrapeTokens = nScrapeAddr.split(/\s+/);
    const matches = dbTokens.filter(t => scrapeTokens.includes(t)).length;
    const tokenScore = matches / Math.max(dbTokens.length, 1);
    
    addrScore = Math.max(addrScore, tokenScore);
  } else if (!nScrapeAddr && nameScore > 0.9) {
    addrScore = 1; // if Tripadvisor doesn't have address but name is identical, we trust it more
  }

  // Weight name heavily (70%), address (30%)
  return (nameScore * 0.7) + (addrScore * 0.3);
}

async function callOpenAI(prompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: AI_CONFIG.review_model,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`OpenAI API returned ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

async function resolveTripadvisorUrl(businessName: string, location: string): Promise<string | null> {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return null;
  const q = `${businessName} ${location} site:tripadvisor.com`.trim();
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}&api_key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const firstRes = data.organic_results?.[0]?.link;
  if (firstRes && firstRes.includes("tripadvisor.com/")) return firstRes;
  return null;
}

export async function runTripadvisorEnrichJob(input_data: any, userId: string, job: any) {
  const { leadId, url: inputUrl } = input_data;
  if (!leadId) return { skipped: true, reason: "Missing leadId" };

  const cbState = await checkCircuitBreaker("tripadvisor_enrich", redis);
  if (cbState === "OPEN") {
    console.warn(`[TripadvisorEnrich] Circuit Open. Delaying job ${job.id}`);
    await job.moveToDelayed(Date.now() + 600000 + Math.floor(Math.random() * 60000), job.token).catch(() => {});
    throw new DelayedError();
  }

  // Fetch current lead
  const { data: lead } = await supabase.from('leads').select('*').eq('id', leadId).single();
  if (!lead) return { skipped: true, reason: "Lead not found" };

  const currentExtraData = lead.extra_data || {};
  const currentTripadvisorIntel = currentExtraData.tripadvisor_intelligence || {};
  
  let targetUrl = inputUrl || currentTripadvisorIntel.url;
  
  const trace: AnalysisTrace = {
    url_resolved: false,
    confidence: 0,
    ai_ran: false,
    skip_reason: null
  };
  
  let creditsToCharge = 0;

  // 1. URL Resolution
  if (!targetUrl) {
    const bizName = lead.company || lead.name || "";
    const loc = lead.address || lead.location || "";
    if (bizName) {
      targetUrl = await resolveTripadvisorUrl(bizName, loc);
      if (targetUrl) {
        trace.url_resolved = true;
        creditsToCharge += 1; // 1 credit for URL resolve
      }
    }
  }

  if (!targetUrl) {
    trace.skip_reason = "NOT_FOUND";
    await updateLeadStatus(leadId, TripadvisorStatus.NOT_FOUND, currentExtraData, trace);
    return { success: false, reason: "NOT_FOUND" };
  }

  // 2. Fetch HTML
  let html = "";
  const routing = analyzeJobRisk({ domain: targetUrl, type: "tripadvisor_enrich" });
  let proxyId: string | null = null;

  try {
    const pageRes = await fetchPage(targetUrl, { method: "GET" });
    if (pageRes.ok && pageRes.html && pageRes.html.length > 5000) {
      html = pageRes.html;
    } else {
      if (pageRes.status === 401 || pageRes.status === 403 || pageRes.status === 429) {
        throw new Error(`HTTP ${pageRes.status}`);
      }
      const proxy = await getProxyManager().getBest(routing);
      if (proxy) proxyId = proxy.id;
      const browser = await getBrowserPool().acquire(proxy);
      try {
        const page = await browser.newPage();
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        html = await page.content();
        await browser.close();
      } catch (e) {
        await browser.close();
        throw e;
      }
    }

    if (!html || html.length < 500) throw new Error("HTML Empty");

    // 3. Extract & Validate Confidence
    const $ = cheerio.load(html);
    const scrapedName = $('h1').first().text().trim() || "";
    const scrapedAddress = $('span.kngSA').first().text().trim() || ""; // Tripadvisor address class approximation

    const confidence = calculateConfidence(lead.company || lead.name || "", lead.address || "", scrapedName, scrapedAddress);
    trace.confidence = confidence;

    if (confidence < 0.75) {
      trace.skip_reason = "LOW_CONFIDENCE";
      await updateLeadStatus(leadId, TripadvisorStatus.LOW_CONFIDENCE, currentExtraData, trace);
      if (creditsToCharge > 0) await chargeBatchForLeads(supabase, userId, null, creditsToCharge);
      return { success: false, reason: "LOW_CONFIDENCE", confidence };
    }

    // 4. Extract Metrics
    const ratingText = $('.ZDEqb').text() || $('svg[aria-label*="bubbles"]').attr('aria-label') || null;
    const reviewCountText = $('.IcelI').text() || $('span:contains("reviews")').first().text() || null;

    let rating: number | null = null;
    if (ratingText) {
      const m = ratingText.match(/[\d.]+/);
      if (m) rating = parseFloat(m[0]);
    }
    let reviewCount = 0;
    if (reviewCountText) {
      const m = reviewCountText.replace(/,/g, '').match(/\d+/);
      if (m) reviewCount = parseInt(m[0], 10);
    }

    // Opportunity Score (Raw) - Formula Based
    let oppScoreRaw: number | null = null;
    let status = TripadvisorStatus.FOUND;
    let oppStatus = TripadvisorStatus.FOUND;

    if (rating === null) {
      oppStatus = TripadvisorStatus.INSUFFICIENT_DATA;
    } else {
      const wRating = ((5 - rating) / 5) * OPPORTUNITY_SCORE_WEIGHTS.rating;
      const wWeb = (lead.website) ? OPPORTUNITY_SCORE_WEIGHTS.website : 0; // website deduped logic
      const wRev = Math.min((reviewCount / 100), 1) * OPPORTUNITY_SCORE_WEIGHTS.reviews;
      // Sentiment & OwnerReplies added after AI
      oppScoreRaw = Math.round(wRating + wWeb + wRev);
    }

    // Extract Reviews
    const extractedReviews: string[] = [];
    $('[data-automation="reviewCard"], .review-container, .yCeTE').each((i, el) => {
      if (i >= 15) return;
      const revText = $(el).find('q, .yCeTE span').text().trim();
      if (revText && revText.length > 20) extractedReviews.push(revText);
    });

    // 5. AI Optimization / Skip Logic
    let intel = { ...currentTripadvisorIntel, url: targetUrl };
    const lastAiAt = currentTripadvisorIntel.last_analyzed_at ? new Date(currentTripadvisorIntel.last_analyzed_at).getTime() : 0;
    const daysSinceAi = (Date.now() - lastAiAt) / (1000 * 60 * 60 * 24);
    
    let shouldRunAI = false;
    if (reviewCount < 30) {
      trace.skip_reason = "SKIPPED_INSUFFICIENT_DATA_COUNT";
    } else if (intel.review_count === reviewCount && daysSinceAi < 30) {
      trace.skip_reason = "SKIPPED_CACHE_HIT";
    } else if (intel.rating !== rating) {
      shouldRunAI = true; // Rating changed
    } else if (intel.review_count && reviewCount > intel.review_count * 1.2) {
      shouldRunAI = true; // Review count increased 20%
    } else if (!intel.sentiment) {
      shouldRunAI = true; // Never ran
    } else {
      trace.skip_reason = "SKIPPED_NO_SIGNIFICANT_CHANGE";
    }

    if (shouldRunAI && extractedReviews.length > 0) {
      trace.ai_ran = true;
      creditsToCharge += (intel.ai_version ? 2 : 3); // 2 for reanalysis, 3 for initial

      const aiPrompt = `You are a B2B business intelligence AI analyzing Tripadvisor reviews for a company.
Rating: ${rating}, Reviews: ${reviewCount}
Reviews:\n${extractedReviews.map((r, i) => `[${i + 1}] ${r}`).join("\n")}
Task: Output STRICT JSON:
- "sentiment": {"positive": %, "negative": %} (sum 100)
- "pain_points": brief summary of issues (string)
- "complaints": array of strings, up to 3 common complaints
- "positives": array of strings, up to 3 common praises
- "owner_replies_pct": integer 0-100 estimating % of reviews replied to
- "buying_signals": array from exactly this list: ${JSON.stringify(ALLOWED_BUYING_SIGNALS)}
- "risk_level": "high", "medium", or "low"`;

      try {
        const aiResultText = await callOpenAI(aiPrompt);
        const aiData = JSON.parse(aiResultText);
        
        intel = {
          ...intel,
          sentiment: aiData.sentiment || { positive: 0, negative: 0 },
          pain_points: aiData.pain_points || "",
          complaints: aiData.complaints || [],
          positives: aiData.positives || [],
          owner_replies_pct: aiData.owner_replies_pct || 0,
          buying_signals: aiData.buying_signals || [],
          ai_version: "v2",
          last_analyzed_at: new Date().toISOString()
        };
      } catch (aiErr) {
        console.warn(`[TripadvisorEnrich] AI failed:`, aiErr);
      }
    }

    // Opportunity Score (AI)
    let oppScoreAi: number | null = oppScoreRaw;
    if (oppScoreAi !== null && intel.sentiment) {
      const wSent = (intel.sentiment.negative / 100) * OPPORTUNITY_SCORE_WEIGHTS.sentiment;
      const wOwn = (intel.owner_replies_pct === 0) ? OPPORTUNITY_SCORE_WEIGHTS.ownerReplies : 0;
      oppScoreAi = Math.max(0, Math.min(100, Math.round(oppScoreRaw + wSent + wOwn)));
    }

    intel.rating = rating;
    intel.review_count = reviewCount;
    intel.opportunity_score_raw = oppScoreRaw;
    intel.opportunity_score_ai = oppScoreAi;
    intel.status = oppStatus;
    intel.analysis_trace = trace;

    // 6. DB Update
    await updateLeadStatus(leadId, oppStatus, { ...currentExtraData, tripadvisor_intelligence: intel }, trace);
    
    await recordSuccess("tripadvisor_enrich", redis);
    if (proxyId) await getProxyManager().markSuccess(proxyId, 0);

    // 7. Billing
    if (creditsToCharge > 0) {
      await chargeBatchForLeads(supabase, userId, null, creditsToCharge);
    }

    return { success: true, intel, trace };
  } catch (err: any) {
    if (proxyId) await getProxyManager().markFail(proxyId);
    await recordFailure("tripadvisor_enrich", redis);
    
    trace.skip_reason = "ERROR_RETRYABLE";
    await updateLeadStatus(leadId, TripadvisorStatus.ERROR_RETRYABLE, currentExtraData, trace);
    
    throw err;
  }
}

async function updateLeadStatus(leadId: string, status: TripadvisorStatus, extraData: any, trace: AnalysisTrace) {
  if (!extraData.tripadvisor_intelligence) extraData.tripadvisor_intelligence = {};
  extraData.tripadvisor_intelligence.status = status;
  extraData.tripadvisor_intelligence.analysis_trace = trace;
  await supabase.from('leads').update({ extra_data: extraData }).eq('id', leadId);
}
