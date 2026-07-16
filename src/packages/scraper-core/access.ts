// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any; // Avoid cross-package @supabase version conflict
import { calculateLeadCost, LeadBillingMetadata } from "./credits.js";

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

/**
 * Checks if the user has access to the requested scraping source.
 * All platforms are now unlocked for all users — no plan restrictions.
 * 
 * ✅ FIX: Added structure to easily enable plan-based access in future.
 */
export async function checkSourceAccess(
  supabase: AnySupabase,
  source: string,
  userId: string,
  orgId?: string
): Promise<{ allowed: boolean; planName?: string; requiredTier?: string }> {
  // Current: Always allow (for backward compatibility)
  // Future: Uncomment below to enable plan checks
  /*
  const { data: userData, error } = await supabase
    .from("users")
    .select("plan_type, plan_expires_at")
    .eq("id", userId)
    .single();

  if (error || !userData) return { allowed: false, reason: "user_not_found" };

  const now = new Date();
  const expiresAt = new Date(userData.plan_expires_at || now);
  if (now > expiresAt) return { allowed: false, reason: "plan_expired" };

  // Define platform access rules per plan
  const PLAN_ACCESS: Record<string, string[]> = {
    free: ["youtube", "google_maps"],
    premium: ["youtube", "instagram", "facebook", "linkedin"],
    enterprise: ["youtube", "instagram", "facebook", "linkedin", "custom_sources"]
  };

  const allowedSources = PLAN_ACCESS[userData.plan_type] || [];
  if (!allowedSources.includes(source)) {
    return { allowed: false, planName: userData.plan_type, requiredTier: "premium" };
  }
  */

  // For now, allow everything
  return { allowed: true };
}

/**
 * Charges credits for a single lead found during scraping.
 * Uses deduct_credits RPC (atomic). Falls back to direct update.
 * Returns { charged: false } on insufficient credits — caller should stop saving leads.
 */
export async function chargeForLead(
  supabase: AnySupabase,
  userId: string,
  orgId: string | undefined,
  source: string,
  metadata?: LeadBillingMetadata
): Promise<{ charged: boolean; reason?: string }> {
  const cost = calculateLeadCost(source, metadata);

  // Cache hits and failed leads are free
  if (cost === 0) return { charged: true };

  const targetId = userId;

  try {
    // Try RPC first (atomic)
    const { error } = await supabase.rpc("deduct_credits", {
      p_user_id: targetId,
      p_org_id: orgId || targetId,
      p_amount: cost,
    });

    if (!error) return { charged: true };

    console.warn("[chargeForLead] RPC failed, trying direct update:", error.message);

    // Fallback: direct update with balance check
    const { data: userRow, error: selectErr } = await supabase
      .from("users")
      .select("credits")
      .eq("id", targetId)
      .single();

    if (selectErr || !userRow) return { charged: false, reason: "user_not_found" };
    if (userRow.credits < cost) return { charged: false, reason: "insufficient_credits" };

    const { error: updateErr } = await supabase
      .from("users")
      .update({ credits: userRow.credits - cost })
      .eq("id", targetId);

    if (updateErr) {
      console.error("[chargeForLead] Direct update also failed:", updateErr.message);
      return { charged: false, reason: "charge_failed" };
    }

    return { charged: true };
  } catch (err: any) {
    console.error("[chargeForLead] Unexpected error:", err.message);
    return { charged: false, reason: "charge_error" };
  }
}

/**
 * Charges total credits for a batch of successfully saved leads.
 * ✅ FIX: Added retry logic and structured error logging for reliability.
 */
export async function chargeBatchForLeads(
  supabase: AnySupabase,
  userId: string,
  orgId: string | undefined,
  totalCost: number
): Promise<{ charged: boolean; reason?: string }> {
  if (totalCost <= 0) return { charged: true };

  const targetId = userId;
  let attempt = 0;

  while (attempt < RETRY_ATTEMPTS) {
    try {
      // Try RPC first (atomic)
      const { error } = await supabase.rpc("deduct_credits", {
        p_user_id: targetId,
        p_org_id: orgId || targetId,
        p_amount: totalCost,
      });

      if (!error) return { charged: true };

      console.error(`[chargeBatchForLeads] RPC attempt ${attempt + 1} failed:`, error.message);
    } catch (err: any) {
      console.error(`[chargeBatchForLeads] RPC attempt ${attempt + 1} threw error:`, err.message);
    }

    // Fallback: direct update with balance check
    try {
      const { data: userRow, error: selectErr } = await supabase
        .from("users")
        .select("credits")
        .eq("id", targetId)
        .single();

      if (selectErr || !userRow) return { charged: false, reason: "user_not_found" };
      if (userRow.credits < totalCost) return { charged: false, reason: "insufficient_credits" };

      const { error: updateErr } = await supabase
        .from("users")
        .update({ credits: userRow.credits - totalCost })
        .eq("id", targetId);

      if (!updateErr) return { charged: true };

      console.error(`[chargeBatchForLeads] Direct update attempt ${attempt + 1} failed:`, updateErr.message);
    } catch (err: any) {
      console.error(`[chargeBatchForLeads] Direct update attempt ${attempt + 1} threw error:`, err.message);
    }

    attempt++;
    if (attempt < RETRY_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt)); // Exponential backoff
    }
  }

  return { charged: false, reason: "charge_failed_after_retries" };
}