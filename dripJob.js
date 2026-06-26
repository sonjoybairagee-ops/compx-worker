import { supabase } from "../config/supabase.js";
 // or wherever we put it, but wait, worker has no access to src/lib/fetchWithAuth...
// I will just use standard fetch or supabase.

export async function runDripJob(jobData) {
  const { enrollment_id } = jobData;

  console.log(`[DripWorker] Processing enrollment ${enrollment_id}`);

  // 1. Fetch enrollment
  const { data: enrollment, error: enrollmentErr } = await supabase
    .from("sequence_enrollments")
    .select(`
      *,
      leads_verified (*),
      sequence_steps (*)
    `)
    .eq("id", enrollment_id)
    .single();

  if (enrollmentErr || !enrollment) {
    console.error(`[DripWorker] Enrollment not found: ${enrollment_id}`);
    return { error: "Enrollment not found" };
  }

  // 2. Check if status is still active
  if (enrollment.status !== "active") {
    console.log(`[DripWorker] Enrollment ${enrollment_id} is no longer active (status: ${enrollment.status}). Skipping.`);
    return { skipped: true, reason: enrollment.status };
  }

  const step = enrollment.sequence_steps;
  if (!step) {
    console.error(`[DripWorker] Step not found for enrollment ${enrollment_id}`);
    return { error: "Step not found" };
  }

  const idempotency_key = `${enrollment.id}_${step.id}`;

  // 3. Check Idempotency (prevent duplicate sends on crash)
  const { data: existingLog } = await supabase
    .from("email_logs")
    .select("id")
    .eq("idempotency_key", idempotency_key)
    .single();

  if (existingLog) {
    console.log(`[DripWorker] Duplicate send prevented for ${idempotency_key}`);
  } else {
    console.log(`[DripWorker] Sending email for step ${step.step_order} to ${enrollment.leads_verified.email}`);
    
    // Here we would call the outreach API or run the actual send logic
    // Since worker might not have all the Next.js API envs, it's safer to POST to the Next.js API internally
    // or implement the send logic directly here if we have all the env vars.
    // Let's implement an internal call to our API to avoid duplicating Spintax and OAuth logic.
    
    const APP_URL = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
    try {
      const response = await fetch(`${APP_URL}/api/outreach/send_drip_internal`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
        },
        body: JSON.stringify({
          enrollment_id: enrollment.id,
          step_id: step.id,
          lead_id: enrollment.leads_verified.id,
          idempotency_key
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API returned ${response.status}: ${errorText}`);
      }
    } catch (err) {
      console.error(`[DripWorker] Failed to send email via API:`, err);
      throw err; // BullMQ will retry
    }
  }

  // 4. Find next step
  const { data: nextStep } = await supabase
    .from("sequence_steps")
    .select("*")
    .eq("sequence_id", enrollment.sequence_id)
    .gt("step_order", step.step_order)
    .order("step_order", { ascending: true })
    .limit(1)
    .single();

  if (nextStep) {
    // Schedule next step
    const nextRunAt = new Date();
    nextRunAt.setDate(nextRunAt.getDate() + nextStep.wait_days);

    await supabase
      .from("sequence_enrollments")
      .update({
        current_step_id: nextStep.id,
        next_run_at: nextRunAt.toISOString()
      })
      .eq("id", enrollment.id);
      
    console.log(`[DripWorker] Scheduled next step ${nextStep.step_order} for ${nextRunAt}`);
  } else {
    // Mark as completed
    await supabase
      .from("sequence_enrollments")
      .update({ status: "completed" })
      .eq("id", enrollment.id);
      
    console.log(`[DripWorker] Sequence completed for enrollment ${enrollment_id}`);
  }

  return { success: true };
}
