/**
 * plugins/linkedin/providers/apify.ts — moved from linkedin/apify.ts.
 * FIX: breaker key was the generic vendor name "apify" — if any other
 * plugin ever integrates Apify too, they'd have shared circuit state.
 * Now keyed by "linkedin-apify" via the router.
 */
import { ProviderError, ProviderErrorType, CIRCUIT_BREAKER_CONFIG } from "@compx/scraper-core";
import type { SourceProvider, ProviderRunContext } from "@compx/scraper-core";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export interface LinkedinApifyInput {
  profileUrls: string[];
}

async function fetchLinkedinApify(input: LinkedinApifyInput, ctx: ProviderRunContext): Promise<any[]> {
  const { profileUrls } = input;
  const { logger } = ctx;
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new ProviderError(ProviderErrorType.UNAUTHORIZED, "APIFY_API_TOKEN is not configured");

  const actorId = process.env.APIFY_LINKEDIN_ACTOR_ID || "apify/linkedin-profile-scraper";

  let allResults: any[] = [];

  for (let attempt = 1; attempt <= CIRCUIT_BREAKER_CONFIG.RETRY_COUNT + 1; attempt++) {
    try {
      await logger.log(`Fetching ${profileUrls.length} profile(s) via Apify (attempt ${attempt})...`);

      const runRes = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs?token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: profileUrls }),
      });

      if (runRes.status >= 500 || runRes.status === 429) {
        throw new Error(`Apify Run HTTP ${runRes.status}`);
      }

      const runData = await runRes.json();
      if (!runData?.data?.id) throw new Error("Failed to start Apify run");

      const runId = runData.data.id;
      const datasetId = runData.data.defaultDatasetId;

      let status = "RUNNING";
      while (status === "RUNNING" || status === "READY") {
        await sleep(5000);
        const statusRes = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs/${runId}?token=${token}`);
        const statusData = await statusRes.json();
        status = statusData?.data?.status;
        if (status === "FAILED" || status === "TIMED-OUT" || status === "ABORTED") {
          throw new Error(`Apify run failed with status: ${status}`);
        }
      }

      const resultsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}`);
      allResults = await resultsRes.json();
      return allResults;
    } catch (err: any) {
      await logger.log(`Apify API fetch failed (attempt ${attempt}): ${err.message}`);
      if (attempt <= CIRCUIT_BREAKER_CONFIG.RETRY_COUNT) {
        const delay = CIRCUIT_BREAKER_CONFIG.BACKOFF[attempt - 1] || 2000;
        await sleep(delay);
      } else {
        throw new Error("Apify request failed after retries");
      }
    }
  }

  return allResults;
}

export const linkedinApifyProvider: SourceProvider<LinkedinApifyInput, any> = {
  name: "linkedin-apify",
  fetch: fetchLinkedinApify,
};
