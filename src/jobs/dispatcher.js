// Job Dispatcher — routes input source → correct job type
// Handles: domain list, extension push, CSV batch, email list

import { supabase } from "../config/supabase.js"
import { runEnrichJob }      from "./enrichJob.js"
import { runDeepScrape }     from "./deepScrapeJob.js"
import { runVerifyEmail }    from "./verifyEmailJob.js"
import { getBestProxy, markProxyFail, markProxySuccess } from "../../../lib/proxy.js"
import { analyzeJobRisk } from "../../../lib/routingEngine.js"

// ── Normalize domain ──────────────────────────────────────────────────────────
function normalizeDomain(raw) {
  return raw.trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .toLowerCase()
}

// ── Classify job type from input ──────────────────────────────────────────────
function classifyJobType(input) {
  const { type, source, emails, domains } = input
  if (type) return type  // explicit override
  if (emails?.length)  return "verify_email"
  if (source === "google_maps" || source === "yellow_pages") return "deep_scrape"
  if (domains?.length) return "enrich"
  throw new Error("Cannot classify job — provide type, emails, or domains")
}

// ── Create job record in Supabase ─────────────────────────────────────────────
async function createJobRecord(userId, jobType, inputData, mode) {
  const { data, error } = await supabase
    .from("enrichment_jobs")
    .insert({
      user_id:    userId,
      type:       jobType,
      status:     mode === "realtime" ? "running" : "queued",
      input_data: inputData,
      progress:   0,
      created_at: new Date().toISOString(),
    })
    .select()
    .single()
  if (error) throw new Error(`DB insert failed: ${error.message}`)
  return data
}

// ── Update job progress ───────────────────────────────────────────────────────
export async function updateJobProgress(jobId, progress, found) {
  await supabase.from("enrichment_jobs").update({
    progress,
    result_summary: { leads_found: found },
    updated_at: new Date().toISOString(),
  }).eq("id", jobId)
}

// ── Main dispatcher ───────────────────────────────────────────────────────────
export async function dispatchJob(userId, input, mode = "realtime") {
  const jobType = classifyJobType(input)
  const job     = await createJobRecord(userId, jobType, input, mode)

  if (mode === "queue") {
    console.log(`[Dispatcher] Queued job ${job.id} (${jobType})`)
    return { jobId: job.id, status: "queued" }
  }

  // Realtime — run immediately
  runJobWorker(job.id, userId, jobType, input).catch(err => {
    console.error(`[Dispatcher] Worker error for ${job.id}:`, err.message)
  })

  return { jobId: job.id, status: "running" }
}

// ── Worker — runs job + proxy + progress updates ──────────────────────────────
async function runJobWorker(jobId, userId, jobType, input) {

  // 1. Risk + geo analysis
  const routing = analyzeJobRisk({
    domain:  input.domain || input.website,
    source:  input.source,
    country: input.country,
    type:    jobType,
  })

  console.log(`[Dispatcher] Job ${jobId} → risk:${routing.riskLevel} geo:${routing.preferredGeo ?? "any"} delay:${routing.delayMs}ms`)

  // 2. Best proxy based on routing
  const proxy   = getBestProxy(routing)
  const started = Date.now()

  // 3. Anti-bot delay
  await sleep(routing.delayMs)

  try {
    await supabase.from("enrichment_jobs").update({
      status: "running", proxy_id: proxy?.id ?? null
    }).eq("id", jobId)

    let result

    if (jobType === "enrich") {
      const domains = input.domains ?? [input.domain]
      result = await runEnrichPipeline(domains, userId, jobId, proxy?.url, routing)
    } else if (jobType === "deep_scrape") {
      result = await runDeepScrape({ ...input, proxyUrl: proxy?.url }, userId)
    } else if (jobType === "verify_email") {
      result = await runVerifyEmail({ ...input }, userId)
    }

    if (result?.paused) return

    const latency = Date.now() - started
    if (proxy) await markProxySuccess(proxy.id, latency)

    await supabase.from("enrichment_jobs").update({
      status:         "completed",
      progress:       100,
      result_summary: result,
      completed_at:   new Date().toISOString(),
    }).eq("id", jobId)

    if (input.auto_verify && result?.emails?.length) {
      await dispatchJob(userId, {
        type: "verify_email", emails: result.emails, leadId: input.leadId
      }, "queue")
    }

  } catch (err) {
    if (proxy) await markProxyFail(proxy.id)
    await supabase.from("enrichment_jobs").update({
      status: "failed", error_msg: err.message,
    }).eq("id", jobId)
    throw err
  }
}

// ── Enrich pipeline — multi-domain with progress ──────────────────────────────
async function runEnrichPipeline(domains, userId, jobId, proxyUrl, routing) {
  const results = []
  for (let i = 0; i < domains.length; i++) {
    // ── Check if paused before continuing ─────────────────────────────────────
    const { data: jobState } = await supabase.from("enrichment_jobs").select("status").eq("id", jobId).single();
    if (jobState?.status === "paused") {
      console.log(`[Dispatcher] Job ${jobId} paused at domain ${i+1}/${domains.length}`);
      await updateJobProgress(jobId, Math.round((i) / domains.length * 100), results.length);
      return { paused: true, domains_processed: i, leads_found: results.length };
    }

    const domain = normalizeDomain(domains[i])
    
    const domainRouting = analyzeJobRisk({ domain })
    await sleep(Math.max(routing?.delayMs ?? 800, domainRouting.delayMs))

    const r = await runEnrichJob({ website: domain, domain, proxyUrl }, userId)
    if (r) results.push(r)
    await updateJobProgress(jobId,
      Math.round((i + 1) / domains.length * 100),
      results.length
    )
  }
  return {
    domains_processed: domains.length,
    leads_found:  results.length,
    emails: results.flatMap(r => r.emails ?? []),
    phones: results.flatMap(r => r.phones ?? []),
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
