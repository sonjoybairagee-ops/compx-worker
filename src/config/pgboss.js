// worker/src/config/pgboss.js
//
// Replaces ioredis + BullMQ's `connection: redis` with a single pg-boss
// instance backed directly by your Supabase Postgres database. pg-boss
// stores queues/jobs in its own schema (default: `pgboss`) inside the SAME
// database — no separate infra to run or pay for.
//
// IMPORTANT — connection string requirements:
//   pg-boss holds a persistent connection and uses LISTEN/NOTIFY internally,
//   so it needs a *session-mode* connection, NOT Supabase's transaction-mode
//   pgbouncer pooler (port 6543). Use one of:
//     - Direct connection:  postgres://postgres:[PASSWORD]@db.[PROJECT_REF].supabase.co:5432/postgres
//     - Supavisor pooler in "session" mode (check Supabase dashboard ->
//       Project Settings -> Database -> Connection string -> "Session")
//
//   Put this in worker/.env as SUPABASE_DB_URL.

import PgBoss from "pg-boss";

const CONNECTION_STRING = process.env.SUPABASE_DB_URL;

if (!CONNECTION_STRING) {
  throw new Error(
    "[PgBoss] SUPABASE_DB_URL is not set. Use Supabase's direct or " +
    "session-mode Postgres connection string (see comment in " +
    "src/config/pgboss.js) — NOT the transaction-mode pooler on port 6543."
  );
}

export const QUEUES = {
  JOBS: "compx-jobs",
  LEAD_ENRICHMENT: "lead_enrichment",
  DRIP_JOBS: "drip_jobs",
  CAMPAIGN_JOBS: "campaign_jobs",
  AI_JOBS: "ai_jobs",
};

let bossInstance = null;
let startingPromise = null;

/**
 * Returns a started, singleton PgBoss instance. Safe to call from multiple
 * files — the underlying start() only runs once.
 */
export async function getBoss() {
  if (bossInstance) return bossInstance;
  if (startingPromise) return startingPromise;

  startingPromise = (async () => {
    const boss = new PgBoss({
      connectionString: CONNECTION_STRING,
      ssl: { rejectUnauthorized: false }, // Supabase requires SSL
      max: 5, // pg-boss's own pool — keep modest, Supabase has connection caps
      retryLimit: 5,
      retryBackoff: true,
      // Auto-cleanup instead of the manual removeOnComplete/removeOnFail
      // config you had in queueRegistry.js:
      archiveCompletedAfterSeconds: 3600,
      deleteAfterDays: 7,
    });

    boss.on("error", (err) => console.error("[PgBoss] error:", err.message));

    await boss.start();

    bossInstance = boss;
    return boss;
  })();

  return startingPromise;
}

export async function shutdownBoss() {
  if (bossInstance) {
    await bossInstance.stop({ graceful: true, timeout: 15000 });
    bossInstance = null;
  }
}
