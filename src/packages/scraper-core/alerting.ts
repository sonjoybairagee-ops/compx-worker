/**
 * scraper-core/alerting.ts
 *
 * Slack alerting for circuit breaker state changes.
 * Fully adapted for Supabase-only architecture (No Redis).
 */

export async function sendSlackAlert(
  provider: string, 
  state: string, 
  reason: string
): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  
  if (!webhookUrl) {
    console.warn(`[Alerting] SLACK_WEBHOOK_URL not configured. Skipping alert for ${provider} → ${state}`);
    return;
  }

  try {
    const payload = {
      text: `🚨 *Circuit Breaker Alert*`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: state === "OPEN" ? "⚠️ Circuit Breaker OPENED" : "✅ Circuit Breaker RECOVERED"
          }
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Provider:*\n${provider}` },
            { type: "mrkdwn", text: `*State:*\n${state}` }
          ]
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Reason:*\n${reason}`
          }
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `<!date^${Math.floor(Date.now() / 1000)}^{date_short} at {time}|${new Date().toISOString()}>`
            }
          ]
        }
      ]
    };

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000) // 5s timeout
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`[Alerting] Slack webhook failed (${response.status}):`, errorText);
    } else {
      console.log(`[Alerting] ✓ Slack alert sent for ${provider} → ${state}`);
    }
  } catch (err: any) {
    console.warn(`[Alerting] Failed to send Slack alert:`, err.message);
  }
}
