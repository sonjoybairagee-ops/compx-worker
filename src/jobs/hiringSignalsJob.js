/**
 * CompX Worker — src/jobs/hiringSignalsJob.js
 *
 * Round 3 change: scoring now matches lib/intelligence/scoring.ts's real
 * boolean-flag formula (is_hiring / has_target_tech / high_traffic), not
 * round 2's continuous weighted-average model. See scoringMath.js header
 * comment for why the worker keeps its own copy of the formula.
 */

import { supabase } from "../config/supabase.js";
import { createLogger } from "../lib/terminalLogger.js";
import {
  groupByCompany,
  searchJobs,
  getStatus,
  calculateCustomScore,
  toScoringSignals,
  fetchScoringWeights,
  fetchCompanyInsight,
} from "../lib/intelligence/scoringMath.js";

export async function runHiringSignals(inputData, userId, job) {
  const jobId = job?.id || "manual";
  const { keyword, location, orgId } = inputData;

  const logger = createLogger(jobId);

  try {
    await logger.log(`Starting hiring signals: "${keyword}" in "${location || "global"}"`);
    if (!keyword) throw new Error("keyword is required");

    let jobs = [];
    const apiKey = process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY;

    if (!apiKey) {
      await logger.log("⚠️ No SerpAPI key found. Generating high-quality mock hiring signals for demonstration...");
      const titles = [
        `Senior ${keyword}`,
        `Lead ${keyword}`,
        `Junior ${keyword}`,
        `${keyword} Developer`,
        `${keyword} Architect`
      ];
      const mockCompanies = [
        { name: "Slack", domain: "slack.com" },
        { name: "Vercel", domain: "vercel.com" },
        { name: "Linear", domain: "linear.app" },
        { name: "Supabase", domain: "supabase.com" },
        { name: "Retool", domain: "retool.com" },
        { name: "Framer", domain: "framer.com" },
        { name: "Netflix", domain: "netflix.com" },
        { name: "Stripe", domain: "stripe.com" }
      ];

      const shuffled = mockCompanies.sort(() => 0.5 - Math.random());
      const selected = shuffled.slice(0, 4);

      jobs = selected.flatMap((comp) => {
        const companyJobsCount = Math.floor(Math.random() * 3) + 1;
        const companyJobs = [];
        for (let i = 0; i < companyJobsCount; i++) {
          companyJobs.push({
            company_name: comp.name,
            title: titles[Math.floor(Math.random() * titles.length)],
            location: location || "San Francisco, CA",
            via: "via LinkedIn",
            related_links: [{ link: `https://${comp.domain}/jobs` }]
          });
        }
        return companyJobs;
      });

      await new Promise(resolve => setTimeout(resolve, 2000));
      await logger.log(`Generated ${jobs.length} mock job postings for ${selected.length} companies.`);
    } else {
      await logger.log("Searching Google Jobs via SerpAPI...");
      try {
        jobs = await searchJobs(keyword, location);
        await logger.log(`Found ${jobs.length} job postings`);
      } catch (err) {
        await logger.log(`SerpAPI error: ${err.message}`);
        throw err;
      }
    }

    if (jobs.length === 0) {
      await logger.log(`No jobs found for "${keyword}"`);
      return { count: 0, signals: [] };
    }

    const companies = groupByCompany(jobs);
    await logger.log(`Found ${companies.length} unique companies hiring`);

    const weights = await fetchScoringWeights(supabase, orgId);

    const signals = [];
    const seenDomains = new Set();

    for (const c of companies) {
      let emails = [];
      let socials = {};
      let techStack = [];
      let domainDiscovered = false;
      let insight = null;

      if (!c.domain) {
        try {
          await logger.log(`Discovering domain & enriching ${c.company}...`);
          const { runEnrichJob } = await import("./enrichJob.js");
          const enrichResult = await runEnrichJob({ name: c.company }, userId);
          if (enrichResult && enrichResult.website) {
            c.domain = enrichResult.website;
            emails = enrichResult.emails || [];
            socials = enrichResult.social_links || {};
            techStack = enrichResult.techStack || [];
            domainDiscovered = true;
          }
        } catch(e) {
          await logger.log(`[Domain Discovery] Failed for ${c.company}: ${e.message}`);
        }
      }

      if (!c.domain) continue; // skip if still no domain
      if (seenDomains.has(c.domain)) continue; // skip duplicates
      seenDomains.add(c.domain);

      insight = await fetchCompanyInsight(supabase, orgId, c.domain);

      if (!domainDiscovered) {
        emails = insight?.emails_found || [];
        socials = insight?.social_links || {};
        techStack = insight?.tech_stack || [];
        
        if (!insight || !insight.emails_found || insight.emails_found.length === 0) {
          try {
            await logger.log(`Enriching domain ${c.domain} using Cheerio/Crawlee...`);
            const { runEnrichJob } = await import("./enrichJob.js");
            const enrichResult = await runEnrichJob({ website: c.domain, domain: c.domain }, userId);
            if (enrichResult && !enrichResult.error) {
              emails = enrichResult.emails || [];
              socials = enrichResult.social_links || {};
              techStack = enrichResult.techStack || [];
              domainDiscovered = true;
            }
          } catch (err) {
            await logger.log(`[Enrichment] Failed for ${c.domain}: ${err.message}`);
          }
        }
      }

      if (domainDiscovered) {
        await supabase.from("company_insights").upsert({
          org_id: orgId,
          domain: c.domain,
          emails_found: emails,
          social_links: socials,
          tech_stack: techStack,
          last_analyzed: new Date().toISOString(),
        }, { onConflict: "org_id,domain" });
      }

      const scoringSignals = toScoringSignals({
        techStack: techStack,
        trafficScore: insight?.traffic_score ?? null,
      });
      const score = calculateCustomScore(scoringSignals, weights);

      signals.push({
        company: c.company,
        domain: c.domain,
        score,
        status: getStatus(score),
        signals: {
          hiring: true,
          growth: score >= 65,
          job_posts: c.jobPosts,
          keywords: [...new Set(c.titles)].slice(0, 5),
          locations: [...new Set(c.locations)].slice(0, 3),
          scoring_signals: scoringSignals,
          enrichment_pending: false,
          emails: emails,
          social_links: socials,
        },
      });
    }

    signals.sort((a, b) => b.score - a.score);

    await logger.log(`Saving ${signals.length} signals to database...`);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const toInsert = signals.filter(s => s.domain).map(s => ({
      org_id: orgId,
      company: s.company,
      domain: s.domain,
      score: s.score,
      status: s.status,
      signals: s.signals,
      dedup_key: `${keyword}_${location || "global"}_${s.domain}`,
      expires_at: expiresAt.toISOString(),
      created_at: new Date().toISOString(),
    }));

    if (toInsert.length > 0) {
      const { error } = await supabase
        .from("intelligence_signals")
        .upsert(toInsert, {
          onConflict: "dedup_key",
          ignoreDuplicates: false,
        });

      if (error) {
        await logger.log(`[ERROR] DB save failed: ${error.message}`);
        throw error;
      }
    }

    const hot = signals.filter(s => s.score >= 80);
    await logger.log(`Hot signals: ${hot.length} companies aggressively hiring`);
    for (const s of signals.slice(0, 5)) {
      await logger.log(`✓ ${s.company} — ${s.status} (score: ${s.score}, jobs: ${s.signals.job_posts})`);
    }
    await logger.log(`Done — ${signals.length} hiring signals saved`);

    return { count: signals.length, signals };

  } finally {
    await logger.close();
  }
}
