import { Router } from "express";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter.js";
import { ExpressAdapter } from "@bull-board/express";
import { getAllQueues } from "./queueRegistry.js";

export function createBullBoardRouter() {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath("/admin/queues");

  const queues = getAllQueues();
  const bullMQAdapters = queues.map((q) => new BullMQAdapter(q));

  createBullBoard({ queues: bullMQAdapters, serverAdapter });

  const router = Router();
  router.use(adminAuthMiddleware);
  router.use("/", serverAdapter.getRouter());

  return router;
}

export function createQueueStatsRouter() {
  const router = Router();
  router.use(adminAuthMiddleware);

  router.get("/stats", async (_req, res) => {
    try {
      const queues = getAllQueues();
      const stats = await Promise.all(
        queues.map(async (queue) => {
          const [waiting, active, completed, failed, delayed, paused] = await Promise.all([
            queue.getWaitingCount(),
            queue.getActiveCount(),
            queue.getCompletedCount(),
            queue.getFailedCount(),
            queue.getDelayedCount(),
            queue.getPausedCount(),
          ]);

          return {
            name: queue.name,
            isDLQ: queue.name.startsWith("dlq"),
            counts: { waiting, active, completed, failed, delayed, paused },
            total: waiting + active + completed + failed + delayed + paused,
          };
        })
      );

      const dlqAlerts = stats
        .filter((s) => s.isDLQ && s.counts.waiting > 0)
        .map((s) => ({
          queue: s.name,
          pendingCount: s.counts.waiting,
          message: `⚠️ ${s.counts.waiting} job(s) stuck in ${s.name}`,
        }));

      res.json({ ok: true, timestamp: new Date().toISOString(), queues: stats, alerts: dlqAlerts });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  return router;
}

function adminAuthMiddleware(req, res, next) {
  const adminSecret = process.env.BULL_BOARD_SECRET;

  if (!adminSecret) {
    if (process.env.NODE_ENV !== "production") {
      next();
      return;
    }
    res.status(500).json({ error: "BULL_BOARD_SECRET not configured" });
    return;
  }

  const authHeader = req.headers.authorization || "";
  if (authHeader === `Bearer ${adminSecret}`) {
    next();
    return;
  }

  if (authHeader.startsWith("Basic ")) {
    const [, password] = Buffer.from(authHeader.slice(6), "base64").toString().split(":");
    if (password === adminSecret) {
      next();
      return;
    }
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="CompX Admin"');
  res.status(401).json({ error: "Unauthorized" });
}
