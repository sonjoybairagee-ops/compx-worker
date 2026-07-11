/**
 * plugins/linkedin/login.ts — same pattern as instagram/login.ts (roadmap
 * Phase 7: "Structure একই"). One-off bootstrap script, not part of the
 * regular job flow.
 */

import type { Browser } from "playwright";
import { SessionManager } from "@compx/scraper-core";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

export async function loginAndStoreSession(
  browser: Browser,
  accountLabel: string,
  email: string,
  password: string
): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#username", { timeout: 15_000 });
  await page.fill("#username", email);
  await page.fill("#password", password);
  await page.click('button[type="submit"]');

  await page.waitForTimeout(4000);

  const loggedIn = await page
    .waitForSelector('img.global-nav__me-photo, div.global-nav__me', { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  if (!loggedIn) {
    await context.close();
    throw new Error(
      `LinkedIn login for "${accountLabel}" did not reach the feed — likely hit a security checkpoint/2FA. Solve manually in a headed browser once, then export storageState.`
    );
  }

  const storageState = await context.storageState();

  const supabase = createClient(
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
    {
      realtime: {
        transport: ws as any,
      },
    }
  );
  const sessions = new SessionManager(supabase);
  await sessions.registerSession("linkedin", accountLabel, storageState);

  console.log(`[LinkedInLogin] Session "${accountLabel}" stored.`);
  await context.close();
}
