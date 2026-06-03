import { Worker } from "bullmq";
import IORedis from "ioredis";
import { handleScrape } from "./scraper";
import { saveLead } from "./save";
import { runCampaign } from "./campaignRunner";
import { safeRun } from "@/lib/worker/safeRun";

const connection = new IORedis(process.env.REDIS_URL || "redis://localhost:6379");

new Worker(
  "scrape-jobs",
  async (job) => {
    console.log("Processing:", job.name, job.data);

    // Retry logic: allow up to 3 attempts
    if (job.attemptsMade < 3) {
      if (job.name === "scrape") {
        return await safeRun(async () => {
          const result = await handleScrape(job.data);

          if (job.data.orgId) {
            await saveLead(job.data.orgId, result);
          }

          return result;
        });
      }

      if (job.name === "run_campaign") {
        return await safeRun(() =>
          runCampaign(job.data.campaign, job.data.leads)
        );
      }
    } else {
      console.error("Job failed after 3 attempts:", job.id);
    }
  },
  { connection: connection as any }
);
