/**
 * plugins/instagram/login.ts
 * Updated with better selectors and error handling
 *
 * FIXES APPLIED:
 *  1. Supabase service role key moved to env var (was hardcoded — rotate the old
 *     key in Supabase Dashboard → Project Settings → API, it's now compromised).
 *  2. Login browser now launches through the SAME proxy as the scraping job,
 *     so the session's IP/country matches at login time and at scrape time.
 *     (Previously login had no proxy at all → Bangladesh IP at login,
 *     Australia/rotating IP at scrape → Instagram flags it as account takeover
 *     and force-logs-out the session.)
 */

import "dotenv/config";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import * as fs from "fs";
import crypto from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  { realtime: { transport: ws as any } }
);

// ── Proxy config — MUST match what browser-pool.ts uses for scraping ────────
// Uses the same PROXY_SERVER / PROXY_USERNAME / PROXY_PASSWORD env vars so the
// session is created from the same IP it will later be used from.
function getProxyConfig() {
  if (!process.env.PROXY_SERVER) {
    console.warn(
      "⚠️  No PROXY_SERVER set in .env — login will run on this machine's " +
      "direct IP. If scraping later runs through a residential proxy, " +
      "Instagram will likely flag/kill this session as a location mismatch."
    );
    return undefined;
  }
  return {
    server: process.env.PROXY_SERVER,
    username: process.env.PROXY_USERNAME,
    password: process.env.PROXY_PASSWORD,
  };
}

async function loginToInstagram(email: string, password: string, sessionName: string) {
  console.log(`🔐 Logging into Instagram as ${email}...`);

  const proxy = getProxyConfig();
  if (proxy) {
    console.log(`🌐 Launching with proxy: ${proxy.server}`);
  }

  const browser = await chromium.launch({
    headless: false,
    proxy,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    locale: "en-US",
  });

  const page = await context.newPage();

  try {
    // 1. Instagram login page-এ যান
    console.log("📍 Navigating to Instagram login...");
    await page.goto("https://www.instagram.com/accounts/login/", { 
      waitUntil: "domcontentloaded",
      timeout: 60000 
    });

    await page.waitForTimeout(3000);

    // 2. Already logged in? Check if we're on home page
    const currentUrl = page.url();
    if (currentUrl.includes("instagram.com") && !currentUrl.includes("/accounts/login")) {
      console.log("✅ Already logged in! Extracting session...");
      await extractAndSaveSession(context, sessionName);
      return;
    }

    // 3. Cookie consent/allow cookies button click
    console.log("🍪 Checking for cookie consent...");
    const cookieButtons = [
      page.locator('button:has-text("Allow")').first(),
      page.locator('button:has-text("Accept")').first(),
      page.locator('button:has-text("Allow all")').first(),
      page.locator('button:has-text("Allow essential and optional cookies")').first(),
    ];

    for (const btn of cookieButtons) {
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click();
        console.log("✅ Cookie consent handled");
        await page.waitForTimeout(1000);
        break;
      }
    }

    // 4. Login form fill - Multiple selector strategies
    console.log("📝 Filling login form...");
    
    // Username field
    const usernameSelectors = [
      'input[name="username"]',
      'input[aria-label="Phone number, username, or email"]',
      'input[type="text"]',
    ];

    let usernameFilled = false;
    for (const selector of usernameSelectors) {
      const field = page.locator(selector).first();
      if (await field.isVisible({ timeout: 2000 }).catch(() => false)) {
        await field.fill(email);
        console.log(`✅ Username filled using: ${selector}`);
        usernameFilled = true;
        break;
      }
    }

    if (!usernameFilled) {
      console.warn("⚠️ Could not find username field. Trying manual input...");
    }

    // Password field
    const passwordSelectors = [
      'input[name="password"]',
      'input[type="password"]',
    ];

    let passwordFilled = false;
    for (const selector of passwordSelectors) {
      const field = page.locator(selector).first();
      if (await field.isVisible({ timeout: 2000 }).catch(() => false)) {
        await field.fill(password);
        console.log(`✅ Password filled using: ${selector}`);
        passwordFilled = true;
        break;
      }
    }

    if (!passwordFilled) {
      console.warn("⚠️ Could not find password field.");
    }

    await page.waitForTimeout(1000);

    // 5. Login button click - Multiple strategies
    console.log("🔑 Attempting to login...");
    const loginButtonSelectors = [
      'button[type="submit"]',
      'button:has-text("Log in")',
      'button:has-text("Log In")',
      'div[role="button"]:has-text("Log in")',
      '.x193iq5w', // Instagram's dynamic class
    ];

    let loginClicked = false;
    for (const selector of loginButtonSelectors) {
      const btn = page.locator(selector).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        try {
          await btn.click();
          console.log(`✅ Login button clicked using: ${selector}`);
          loginClicked = true;
          break;
        } catch (err) {
          console.warn(`⚠️ Click failed for ${selector}, trying next...`);
        }
      }
    }

    if (!loginClicked) {
      console.warn("⚠️ Could not find login button. You may need to click manually.");
    }

    // 6. Wait for navigation/login to complete
    console.log("⏳ Waiting for login to complete...");
    console.log("   → If CAPTCHA/2FA appears, solve it manually in the browser");
    console.log("   → Timeout: 2 minutes");

    try {
      await page.waitForURL("**/instagram.com/**", { timeout: 120000 });
      await page.waitForTimeout(5000);
    } catch (err) {
      console.warn("⚠️ Navigation timeout. Checking if logged in anyway...");
    }

    // 7. Handle "Save Login Info" modal
    console.log("📱 Handling post-login modals...");
    await page.waitForTimeout(2000);
    
    const notNowSelectors = [
      'button:has-text("Not now")',
      'a:has-text("Not now")',
      'div:has-text("Not now")',
    ];

    for (const selector of notNowSelectors) {
      const btn = page.locator(selector).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click();
        console.log("✅ 'Not now' button clicked");
        await page.waitForTimeout(1000);
        break;
      }
    }

    // 8. Verify login success
    const finalUrl = page.url();
    const isLoggedIn = finalUrl.includes("instagram.com") && 
                       !finalUrl.includes("/accounts/login") &&
                       !finalUrl.includes("/challenge");

    if (!isLoggedIn) {
      console.error("❌ Login failed or blocked. Current URL:", finalUrl);
      console.log("   → Check if credentials are correct");
      console.log("   → Solve any CAPTCHA manually");
      throw new Error("Login verification failed");
    }

    console.log("✅ Login successful!");
    console.log(`📍 Current URL: ${finalUrl}`);

    // 9. Extract and save session
    await extractAndSaveSession(context, sessionName);

  } catch (err: any) {
    console.error("❌ Login error:", err.message);
    throw err;
  } finally {
    await browser.close();
  }
}

async function extractAndSaveSession(context: any, sessionName: string) {
  console.log("💾 Extracting session data...");
  
  try {
    const sessionData = await context.storageState();
    console.log(`   → Cookies: ${sessionData.cookies.length}`);
    console.log(`   → Local Storage entries: ${sessionData.origins.length}`);

    // ✅ FIX: onConflict must target the actual unique constraint
    // (platform, account_label) — not `id`, since a fresh random UUID is
    // generated every run and will never match an existing row. Without
    // this, re-running login.ts for the same account throws:
    // "duplicate key value violates unique constraint scraper_sessions_platform_account_label_key"
    const { error } = await supabase.from("scraper_sessions").upsert(
      {
        id: crypto.randomUUID(),
        platform: "instagram",
        account_label: sessionName,
        storage_state: sessionData,
        status: "active",
        in_use: false,
        fail_count: 0,
        last_used_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "platform,account_label" }
    );

    if (error) {
      console.error("❌ Failed to save to Supabase:", error.message);
      throw error;
    }

    console.log(`✅ Session "${sessionName}" saved to Supabase!`);
    console.log("\n🎉 You can now close this window.");
    console.log("   Next step: Run Instagram scraping job");

  } catch (err: any) {
    console.error("❌ Failed to extract session:", err.message);
    throw err;
  }
}

// CLI arguments
const email = process.argv[2];
const password = process.argv[3];
const sessionName = process.argv[4] || "instagram-main";

if (!email || !password) {
  console.log("❌ Usage: npx tsx login.ts <email> <password> [sessionName]");
  console.log("Example: npx tsx login.ts <your-email> <your-password> instagram-main");
  process.exit(1);
}

loginToInstagram(email, password, sessionName)
  .then(() => process.exit(0))
  .catch(() => process.exit(1));