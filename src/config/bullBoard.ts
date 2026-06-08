import express, { Router, Request, Response, NextFunction } from "express";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { getAllQueues } from "./queueRegistry";

// ─── Bull-Board Router Factory ────────────────────────────────────────────────
// আপনার Express app-এ এভাবে ব্যবহার করুন:
//   app.use("/admin/queues", createBullBoardRouter());

export function createBullBoardRouter(): Router {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath("/admin/queues");

  // সব queues (main + DLQ) Bull-Board-এ register করো
  const queues = getAllQueues();
  const bullMQAdapters = queues.map((q) => new BullMQAdapter(q));

  createBullBoard({
    queues: bullMQAdapters,
    serverAdapter,
  });

  const router = Router();

  // ─── Auth Middleware ────────────────────────────────────────────────────────
  // Production-এ এই route admin-only রাখতে হবে!
  router.use(adminAuthMiddleware);

  // Bull-Board এর built-in router
  router.use("/", serverAdapter.getRouter());

  return router;
}

// ─── Simple Admin Auth Middleware ─────────────────────────────────────────────
// Basic auth — Bearer token দিয়ে protect করা হয়েছে।
// Production-এ আপনার existing auth middleware দিয়ে replace করুন।

function adminAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const adminSecret = process.env.BULL_BOARD_SECRET;

  if (!adminSecret) {
    // Development mode: no auth required
    if (process.env.NODE_ENV !== "production") {
      next();
      return;
    }
    res.status(500).json({ error: "BULL_BOARD_SECRET not configured" });
    return;
  }

  // Bearer token check
  const authHeader = req.headers.authorization;
  if (authHeader === `Bearer ${adminSecret}`) {
    next();
    return;
  }

  // Basic auth check (browser-friendly)
  const basicAuth = req.headers.authorization;
  if (basicAuth?.startsWith("Basic ")) {
    const credentials = Buffer.from(basicAuth.slice(6), "base64").toString();
    const [, password] = credentials.split(":");
    if (password === adminSecret) {
      next();
      return;
    }
  }

  // Unauthorized
  res.setHeader("WWW-Authenticate", 'Basic realm="CompX Admin"');
  res.status(401).json({ error: "Unauthorized — Admin access only" });
}

// ─── Queue Stats API ──────────────────────────────────────────────────────────
// /admin/queues/api/stats — JSON format-এ সব queue-এর stats

export function createQueueStatsRouter(): Router {
  const router = Router();
  router.use(adminAuthMiddleware);

  router.get("/stats", async (_req: Request, res: Response) => {
    try {
      const queues = getAllQueues();
      const stats = await Promise.all(
        queues.map(async (queue) => {
          const [waiting, active, completed, failed, delayed, paused] =
            await Promise.all([
              queue.getWaitingCount(),
              queue.getActiveCount(),
              queue.getCompletedCount(),
              queue.getFailedCount(),
              queue.getDelayedCount(),
              queue.getPausedCount(),
            ]);

          return {
            name: queue.name,
            isDLQ: queue.name.startsWith("dlq:"),
            counts: { waiting, active, completed, failed, delayed, paused },
            total: waiting + active + completed + failed + delayed + paused,
          };
        })
      );

      // Alert: DLQ-তে কোনো job জমে গেছে কিনা
      const dlqAlerts = stats
        .filter((s) => s.isDLQ && s.counts.waiting > 0)
        .map((s) => ({
          queue: s.name,
          pendingCount: s.counts.waiting,
          message: `⚠️ ${s.counts.waiting} job(s) stuck in ${s.name}`,
        }));

      res.json({
        ok: true,
        timestamp: new Date().toISOString(),
        queues: stats,
        alerts: dlqAlerts,
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  return router;
}
