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
  
  try {
    // FIX: More robust selectors for email/password inputs
    await page.waitForSelector('input[name="email"], input#email', { timeout: 15_000 });
    await page.fill('input[name="email"], input#email', email);
    await page.fill('input[name="pass"], input#pass', password);
    
    // FIX: Click login button (handles various UI versions)
    await page.locator('button[name="login"], button[data-cookiebanner="accept_button"], button:has-text("Log In")').first().click();
  } catch (e) {
    await context.close();
    throw new Error(`Failed to interact with login form for "${accountLabel}": ${e}`);
  }

  await page.waitForTimeout(5000);

  // Facebook often shows "Save your login info?" / notification prompts post-login.
  const dismissSelectors = [
    'button:has-text("Not now")',
    'button:has-text("Not Now")',
    'div[role="dialog"] button:has-text("Not now")',
    '[aria-label="Close"]'
  ];
  
  for (const sel of dismissSelectors) {
    await page.locator(sel).first().click({ timeout: 2000 }).catch(() => null);
    await page.waitForTimeout(800);
  }

  // FIX: More robust success check
  const loggedIn = await page
    .waitForSelector('[aria-label="Home"], svg[aria-label="Home"], a[aria-label="Home"]', { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  if (!loggedIn) {
    // Take screenshot for debugging
    await page.screenshot({ path: `facebook-login-fail-${accountLabel}.png` }).catch(() => {});
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
  );
  const sessions = new SessionManager(supabase);
  await sessions.registerSession("facebook", accountLabel, storageState);

  console.log(`[FacebookLogin] ✅ Session "${accountLabel}" stored successfully.`);
  await context.close();
}