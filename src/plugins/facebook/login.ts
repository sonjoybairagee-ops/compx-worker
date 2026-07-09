/**
 * plugins/facebook/login.ts — same pattern as instagram/login.ts and
 * linkedin/login.ts. One-off bootstrap script (`node --loader tsx
 * login.ts <label> <email> <pass>`), not part of the regular job flow.
 * Normal scrape jobs never call this directly — they pull an
 * already-hydrated context from SessionManager.acquireContextWithSession().
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

  await page.goto("https://www.facebook.com/login", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[name="email"]', { timeout: 15_000 });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="pass"]', password);
  await page.click('button[name="login"]');

  await page.waitForTimeout(4000);

  // Facebook often shows "Save your login info?" / notification prompts post-login.
  const dismissButtons = ['text="Not now"', 'text="Not Now"'];
  for (const sel of dismissButtons) {
    await page.locator(sel).first().click({ timeout: 3000 }).catch(() => null);
    await page.waitForTimeout(1000);
  }

  const loggedIn = await page
    .waitForSelector('[aria-label="Home"]', { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  if (!loggedIn) {
    await context.close();
    throw new Error(
      `Facebook login for "${accountLabel}" did not reach the home screen — likely hit a checkpoint/2FA challenge. Solve it manually in a headed browser once, then export storageState.`
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
  ); // Cast to avoid cross-package @supabase version mismatch
  const sessions = new SessionManager(supabase);
  await sessions.registerSession("facebook", accountLabel, storageState);

  console.log(`[FacebookLogin] Session "${accountLabel}" stored.`);
  await context.close();
}
