/**
 * Sends a "new companies hiring" alert email via Resend's REST API.
 *
 * This is intentionally a thin fetch() call rather than the Resend SDK, so it
 * has zero new dependencies. If RESEND_API_KEY isn't set, this silently no-ops
 * — dashboard alerts (the `alerts` table) still work regardless, so scheduled
 * monitoring is fully functional even before an email account is wired up.
 *
 * Swap this out for SendGrid/Postmark/whatever you already use — the caller
 * (runSavedSearchesJob.js) only depends on this throwing on failure and
 * resolving on success.
 */
export async function sendAlertEmail(recipientEmail, search, newSignals) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !recipientEmail) return; // not configured — dashboard alert already recorded

  const lines = newSignals
    .map(s => `- ${s.company} — score ${s.score} (${s.jobPosts} open role${s.jobPosts === 1 ? "" : "s"})`)
    .join("\n");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.ALERTS_FROM_EMAIL || "alerts@yourdomain.com",
      to: recipientEmail,
      subject: `${newSignals.length} new compan${newSignals.length === 1 ? "y" : "ies"} hiring for "${search.keyword}"`,
      text: `New hiring signals for your saved search "${search.keyword}" (${search.location || "global"}):\n\n${lines}`,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend error: ${res.status} ${body}`);
  }
}
