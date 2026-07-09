/**
 * scraper-core/session/session-manager.ts
 *
 * Phase 10 from the roadmap: per-platform session pools (Instagram Session
 * A/B/C/D, LinkedIn, Google — each platform's logged-in accounts rotated
 * independently). Did not exist in the old codebase — instagram/login.ts
 * style modules logged in fresh (or reused one hardcoded session) per job.
 *
 * A "session" here = a Playwright storageState (cookies + localStorage)
 * persisted in Supabase, checked out for a job, checked back in (or
 * invalidated on failure/logout-detection) when done.
 */

import { SupabaseClient } from "@supabase/supabase-js";
import type { BrowserContext } from "playwright";

export interface SessionRecord {
  id: string;
  platform: string; // "instagram" | "linkedin" | "google"
  account_label: string; // "Session A", "Session B", ...
  storage_state: any; // Playwright storageState JSON
  status: "active" | "cooldown" | "banned";
  last_used_at: string | null;
  fail_count: number;
  in_use: boolean;
}

export interface SessionLease {
  session: SessionRecord;
  applyTo: (context: BrowserContext) => Promise<void>; // hydrate cookies into a fresh context — storageState is set at context-creation time in Playwright, this wraps that
  release: (opts?: { invalidate?: boolean; updatedState?: any }) => Promise<void>;
}

const COOLDOWN_MS = 15 * 60_000; // 15 min cooldown after a fail, before eligible again
const MAX_FAILS_BEFORE_BAN = 3;

export class SessionManager {
  constructor(private supabase: SupabaseClient, private table = "scraper_sessions") {}

  /** Checks out the least-recently-used healthy session for a platform. Marks it in_use to prevent two jobs grabbing the same account concurrently. */
  async acquire(platform: string): Promise<SessionLease | null> {
    const { data: candidates, error } = await this.supabase
      .from(this.table)
      .select("*")
      .eq("platform", platform)
      .eq("status", "active")
      .eq("in_use", false)
      .order("last_used_at", { ascending: true, nullsFirst: true })
      .limit(5);

    if (error) {
      console.error("[SessionManager] load error:", error.message);
      return null;
    }

    const eligible = (candidates || []).find((s) => {
      if (s.status !== "active") return false;
      if (!s.last_used_at) return true;
      return Date.now() - new Date(s.last_used_at).getTime() > 0; // active sessions have no forced gap; cooldown handled via status
    });

    if (!eligible) {
      console.warn(`[SessionManager] No available session for platform "${platform}"`);
      return null;
    }

    const { error: lockErr } = await this.supabase
      .from(this.table)
      .update({ in_use: true })
      .eq("id", eligible.id)
      .eq("in_use", false); // optimistic lock — avoids two workers grabbing the same row

    if (lockErr) {
      console.error("[SessionManager] lock error:", lockErr.message);
      return null;
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

        if (status === "cooldown") {
          setTimeout(() => {
            this.supabase.from(this.table).update({ status: "active" }).eq("id", eligible.id).then(
              () => {},
              () => {}
            );
          }, COOLDOWN_MS);
        }
        console.warn(`[SessionManager] Session ${eligible.account_label} invalidated → ${status} (fail_count: ${nextFailCount})`);
        return;
      }

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
      session: eligible as SessionRecord,
      applyTo: async () => {
        /* storageState is applied at browser.newContext({ storageState }) time — see acquireContextWithSession() below */
      },
      release,
    };
  }

  /** Convenience: acquire a session AND a hydrated context from the given browser in one call. */
  async acquireContextWithSession(
    platform: string,
    browser: import("playwright").Browser,
    extraContextOpts: Record<string, any> = {}
  ): Promise<{ context: BrowserContext; lease: SessionLease } | null> {
    const lease = await this.acquire(platform);
    if (!lease) return null;

    const context = await browser.newContext({
      storageState: lease.session.storage_state || undefined,
      ...extraContextOpts,
    });

    return { context, lease };
  }

  async registerSession(platform: string, accountLabel: string, storageState: any): Promise<void> {
    await this.supabase.from(this.table).upsert(
      {
        platform,
        account_label: accountLabel,
        storage_state: storageState,
        status: "active",
        in_use: false,
        fail_count: 0,
      },
      { onConflict: "platform,account_label" }
    );
  }
}
