import { ProviderError, ProviderErrorType, checkCircuitBreaker, recordFailure, recordSuccess, CIRCUIT_BREAKER_CONFIG } from "@compx/scraper-core";
import type { Redis } from "ioredis";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchLinkedinApify(profileUrls: string[], logger: any, redis: Redis): Promise<any[]> {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new ProviderError(ProviderErrorType.UNAUTHORIZED, "APIFY_API_TOKEN is not configured");

  // We are using a hypothetical or standard Apify actor for LinkedIn.
  // The user said: "If you have your own Actor, even better... Output format your control".
  // We will assume a standard run-sync call to Apify.
  const actorId = process.env.APIFY_LINKEDIN_ACTOR_ID || "apify/linkedin-profile-scraper"; 

  const cbState = await checkCircuitBreaker("apify", redis);
  if (cbState === "OPEN") {
    throw new ProviderError(ProviderErrorType.CIRCUIT_OPEN, "Apify Circuit is OPEN");
  }

  let success = false;
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

      // Poll for completion
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

      // Fetch results
      const resultsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}`);
      allResults = await resultsRes.json();

      await recordSuccess("apify", redis);
      success = true;
      break; 
    } catch (err: any) {
      await logger.log(`Apify API fetch failed (attempt ${attempt}): ${err.message}`);
      if (attempt <= CIRCUIT_BREAKER_CONFIG.RETRY_COUNT) {
        const delay = CIRCUIT_BREAKER_CONFIG.BACKOFF[attempt - 1] || 2000;
        await sleep(delay);
      } else {
        await recordFailure("apify", redis);
        throw new Error("Apify request failed after retries");
      }
    }
  }

  return allResults;
}
