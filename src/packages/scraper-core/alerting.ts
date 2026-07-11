import type { Redis } from "ioredis";

export async function sendSlackAlert(provider: string, state: string, reason: string, redis: Redis) {
  const webhookUrl = process.env.SLACK_ALERT_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    // Deduplication check: prevent spam per state
    const alertKey = `alert:${provider}:${state}`;
    const locked = await redis.setnx(alertKey, "1");
    
    if (locked === 1) {
      // Set TTL for 10 minutes so we don't spam if it keeps failing
      await redis.expire(alertKey, 600);

      const message = {
        text: `🚨 *Provider Alert*\n*Provider:* ${provider}\n*Status:* Circuit Breaker ${state}\n*Reason:* ${reason}`,
      };

      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
      });
    }
  } catch (err: any) {
    // Fail silently if alerting fails, don't interrupt the main flow
    console.error(`[Alerting] Failed to send slack alert for ${provider}:`, err.message);
  }
}
