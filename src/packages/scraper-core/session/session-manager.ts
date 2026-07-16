/**
 * scraper-core/session/session-manager.ts
 *
 * Phase 10 from the roadmap: per-platform session pools (Instagram Session
 * A/B/C/D, LinkedIn, Google — each platform's logged-in accounts rotated
 * independently).
 *
 * A "session" here = a Playwright storageState (cookies + localStorage)
 * persisted in Supabase, checked out for a job, checked back in (or
 * invalidated on failure/logout-detection) when done.
 */

import { SupabaseClient } from "@supabase/supabase-js";
import type { Browser, BrowserContext } from "playwright";
import { createContext, type LaunchOptions } from "../browser/browser-manager.js";

export interface SessionRecord {
  id: string;
  platform: string; // "instagram" | "linkedin" | "facebook" | "youtube"
  account_label: string; // "Session A", "Session B", ...
  storage_state: any; // Playwright storageState JSON
  status: "active" | "cooldown" | "banned";
  last_used_at: string | null;
  fail_count: number;
  in_use: boolean;
}

export interface SessionLease {
  session: SessionRecord;
  release: (opts?: { invalidate?: boolean; updatedState?: any }) => Promise<void>;
}

const COOLDOWN_MS = 15 * 60_000; // 15 min cooldown after a fail
const MAX_FAILS_BEFORE_BAN = 3;

export class SessionManager {
  constructor(private supabase: SupabaseClient, private table = "scraper_sessions") {}

  /** Checks out the least-recently-used healthy session for a platform. */
  async acquire(platform: string): Promise<SessionLease | null> {
    // FIX: Auto-heal sessions that have been in cooldown for longer than COOLDOWN_MS
    const cooldownThreshold = new Date(Date.now() - COOLDOWN_MS).toISOString();
    
    // First, try to reactivate any stuck cooldown sessions for this platform
    await this.supabase
      .from(this.table)
      .update({ status: "active", fail_count: 0 })
      .eq("platform", platform)
      .eq("status", "cooldown")
      .lt("last_used_at", cooldownThreshold);

    // Now fetch the least recently used active session
    const { data: candidates, error } = await this.supabase
      .from(this.table)
      .select("*")
      .eq("platform", platform)
      .eq("status", "active")
      .eq("in_use", false)
      .order("last_used_at", { ascending: true, nullsFirst: true })
      .limit(1); // FIX: Just take the top 1, no need for complex .find()

    if (error || !candidates || candidates.length === 0) {
      console.warn(`[SessionManager] No available session for platform "${platform}"`);
      return null;
    }

    const eligible = candidates[0] as SessionRecord;

    // Optimistic lock — avoids two workers grabbing the same row
    const { error: lockErr, data: lockData } = await this.supabase
      .from(this.table)
      .update({ in_use: true })
      .eq("id", eligible.id)
      .eq("in_use", false) 
      .select()
      .maybeSingle();

    if (lockErr || !lockData) {
      console.error("[SessionManager] lock error or race condition:", lockErr?.message || "Row was updated by another process");
      return null; // Another worker got it, return null to let the job handle fallback/retry
    }

    let released = false;
    const release = async (opts: { invalidate?: boolean; updatedState?: any } = {}) => {
      if (released) return;
      released = true;

      if (opts.invalidate) {
        const nextFailCount = (eligible.fail_count || 0) + 1;
        const status = nextFailCount >= MAX_FAILS_BEFORE_BAN ? "banned" : "cooldown";
        
        await this.supabase
          .from(this.table)
          .update({
            in_use: false,
            fail_count: nextFailCount,
            status,
            last_used_at: new Date().toISOString(),
          })
          .eq("id", eligible.id);

        // FIX: Removed dangerous setTimeout. The acquire() method will auto-heal 
        // this session after COOLDOWN_MS passes.
        console.warn(`[SessionManager] Session ${eligible.account_label} invalidated → ${status} (fail_count: ${nextFailCount})`);
        return;
      }

      // Success: reset fail count and update storage state if provided
      await this.supabase
        .from(this.table)
        .update({
          in_use: false,
          fail_count: 0,
          last_used_at: new Date().toISOString(),
          ...(opts.updatedState ? { storage_state: opts.updatedState } : {}),
        })
        .eq("id", eligible.id);
    };

    return {
      session: eligible,
      release,
    };
  }

  /** 
   * Convenience: acquire a session AND a hydrated context from the given browser in one call.
   * This perfectly bridges SessionManager and BrowserPool.
   */
  async acquireContextWithSession(
    platform: string,
    browser: Browser,
    extraContextOpts: LaunchOptions = {}
  ): Promise<{ context: BrowserContext; lease: SessionLease } | null> {
    const lease = await this.acquire(platform);
    if (!lease) return null;

    const context = await createContext(browser, {
      ...extraContextOpts,
      platform: platform as LaunchOptions["platform"],
      storageState: lease.session.storage_state || undefined,
    });

    return { context, lease };
  }

  /**
   * Register a new session or update an existing one.
   * NOTE: Requires a Unique Constraint on (platform, account_label) in Supabase.
   */
  async registerSession(platform: string, accountLabel: string, storageState: any): Promise<void> {
    const { error } = await this.supabase.from(this.table).upsert(
      {
        platform,
        account_label: accountLabel,
        storage_state: storageState,
        status: "active",
        in_use: false,
        fail_count: 0,
        last_used_at: new Date().toISOString(),
      },
      { onConflict: "platform,account_label" }
    );

    if (error) {
      console.error(`[SessionManager] Failed to register session ${accountLabel}:`, error.message);
      throw error;
    }
  }
}