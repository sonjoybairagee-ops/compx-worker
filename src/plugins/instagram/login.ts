/**
 * plugins/instagram/login.ts
 *
 * Only used to BOOTSTRAP a session (first login for a fresh account) or to
 * re-login when session-manager marks a session "cooldown"/expired and a
 * human/ops action decides to refresh it. Normal scrape jobs never call
 * this directly — they pull an already-hydrated context from
 * SessionManager.acquireContextWithSession().
 *
 * Run this as a one-off script (`node --loader tsx login.ts <label> <user> <pass>`)
 * when provisioning a new Instagram account into the session pool, not as
 * part of the regular job flow.
 */

import type { Browser } from "playwright";
import { SessionManager } from "@compx/scraper-core";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

export async function loginAndStoreSession(
  browser: Browser,
  accountLabel: string,
  username: string,
  password: string
): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://www.instagram.com/accounts/login/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[name="username"]', { timeout: 15_000 });
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');

  // Instagram often shows "Save Login Info" / "Turn on Notifications" dialogs post-login.
  await page.waitForTimeout(4000);
  const dismissButtons = ['text="Not Now"', 'text="Not now"'];
  for (const sel of dismissButtons) {
    await page.locator(sel).first().click({ timeout: 3000 }).catch(() => null);
    await page.waitForTimeout(1000);
  }

  const loggedIn = await page
    .waitForSelector('svg[aria-label="Home"]', { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  if (!loggedIn) {
    await context.close();
    throw new Error(
      `Instagram login for "${accountLabel}" did not reach the home screen — likely hit a checkpoint/2FA challenge. Solve it manually in a headed browser once, then export storageState.`
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
  await sessions.registerSession("instagram", accountLabel, storageState);

  console.log(`[InstagramLogin] Session "${accountLabel}" stored.`);
  await context.close();
}
