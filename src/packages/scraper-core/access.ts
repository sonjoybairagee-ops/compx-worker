// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any; // Avoid cross-package @supabase version conflict
import { calculateLeadCost, LeadBillingMetadata } from "./credits.js";

/**
 * Checks if the user has access to the requested scraping source.
 * All platforms are now unlocked for all users — no plan restrictions.
 */
export async function checkSourceAccess(
  _supabase: AnySupabase,
  _source: string,
  _userId: string,
  _orgId?: string
): Promise<{ allowed: boolean; planName?: string; requiredTier?: string }> {
  // All platforms unlocked — no plan-based restrictions
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

  // Credits live on `users.id`, so the deduction target must always be
  // the billing user id, not the org id.
  const targetId = userId;

  try {
    // Atomic RPC deduction (preferred path)
    const { error } = await supabase.rpc("deduct_credits", {
      p_user_id: targetId,
      p_org_id: orgId || targetId,
      p_amount: cost,
    });

    if (!error) return { charged: true };

    console.warn("[chargeForLead] RPC failed, trying direct update:", error.message);

    // Fallback: direct update with balance check
    const { data: userRow } = await supabase
      .from("users")
      .select("credits")
      .eq("id", targetId)
      .single();

    if (!userRow) return { charged: false, reason: "user_not_found" };
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
 * Falls back to direct update if RPC is missing.
 */
export async function chargeBatchForLeads(
  supabase: AnySupabase,
  userId: string,
  orgId: string | undefined,
  totalCost: number
): Promise<{ charged: boolean; reason?: string }> {
  if (totalCost <= 0) return { charged: true };

  // Credits live on `users.id`, so the deduction target must always be
  // the billing user id, not the org id.
  const targetId = userId;

  // Try RPC first (atomic)
  const { error } = await supabase.rpc("deduct_credits", {
    p_user_id: targetId,
    p_amount:  totalCost,
  });

  if (!error) return { charged: true };

  console.error("[chargeBatchForLeads] RPC FAILED:", {
    message: error.message,
    code:    error.code,
    details: error.details,
    hint:    error.hint,
    targetId,
    orgId,
    userId,
    totalCost,
  });

  // Fallback: direct update
  const { data: userRow } = await supabase
    .from("users")
    .select("credits")
    .eq("id", targetId)
    .single();

  if (userRow) {
    if (userRow.credits < totalCost) {
      return { charged: false, reason: "insufficient_credits" };
    }
    const { error: updateErr } = await supabase
      .from("users")
      .update({ credits: userRow.credits - totalCost })
      .eq("id", targetId);

    if (!updateErr) return { charged: true };
  }

  return { charged: false, reason: "charge_failed" };
}
