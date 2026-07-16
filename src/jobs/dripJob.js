import { supabase } from "../config/supabase.js";
// ✅ FIX: enqueueDripJob is in the frontend lib, not the worker.
// In the worker, use boss.send() directly to schedule next step.
import { getBoss, QUEUES } from "../config/pgboss.js";

export async function runDripJob(jobData) {
  const { enrollment_id } = jobData;

  console.log(`[DripWorker] Processing enrollment ${enrollment_id}`);

  // 1. Fetch enrollment with joined data
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

  // Guard against deleted lead
  if (!enrollment.leads_verified) {
    console.error(`[DripWorker] Lead missing for enrollment ${enrollment_id}. Marking failed.`);
    await supabase
      .from("sequence_enrollments")
      .update({ status: "failed", error_msg: "Lead deleted" })
      .eq("id", enrollment.id);
    return { error: "lead_not_found" };
  }

  // Check active status
  if (enrollment.status !== "active") {
    console.log(`[DripWorker] Enrollment ${enrollment_id} is ${enrollment.status}. Skipping.`);
    return { skipped: true, reason: enrollment.status };
  }

  const step = enrollment.sequence_steps;
  if (!step) {
    console.error(`[DripWorker] Step missing for enrollment ${enrollment_id}`);
    return { error: "Step not found" };
  }

  const idempotency_key = `${enrollment.id}_${step.id}`;

  // 2. Idempotency Check (Prevent duplicate sends)
  const { data: existingLog } = await supabase
    .from("email_logs")
    .select("id")
    .eq("idempotency_key", idempotency_key)
    .maybeSingle();

  if (existingLog) {
    console.log(`[DripWorker] Duplicate send prevented: ${idempotency_key}`);
    // Still need to schedule next step even if this one was a dupe
  } else {
    console.log(`[DripWorker] Sending email for step ${step.step_order} to ${enrollment.leads_verified.email}`);
    
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
        }),
        signal: AbortSignal.timeout(20000), // 20s timeout prevents hanging
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API returned ${response.status}: ${errorText}`);
      }
      
      // Log successful send attempt
      await supabase.from("email_logs").insert({
        enrollment_id: enrollment.id,
        step_id: step.id,
        lead_id: enrollment.leads_verified.id,
        idempotency_key,
        status: "sent",
        sent_at: new Date().toISOString()
      });
      
    } catch (err) {
      console.error(`[DripWorker] Send failed:`, err.message);
      // Update enrollment to failed so it doesn't get retried indefinitely
      await supabase
        .from("sequence_enrollments")
        .update({ status: "failed", error_msg: err.message })
        .eq("id", enrollment.id);
      throw err; // PGMQ will retry based on maxAttempts
    }
  }

  // 3. Schedule Next Step or Complete Sequence
  const { data: nextStep } = await supabase
    .from("sequence_steps")
    .select("*")
    .eq("sequence_id", enrollment.sequence_id)
    .gt("step_order", step.step_order)
    .order("step_order", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (nextStep) {
    // Calculate next run date
    const nextRunAt = new Date();
    nextRunAt.setDate(nextRunAt.getDate() + (nextStep.wait_days || 1));

    // Update current state
    await supabase
      .from("sequence_enrollments")
      .update({
        current_step_id: nextStep.id,
        next_run_at: nextRunAt.toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("id", enrollment.id);
      
    // ✅ FIX: Use boss.send() with startAfterSeconds for delayed next step
    const boss = await getBoss();
    const delaySeconds = (nextStep.wait_days || 1) * 24 * 60 * 60;
    await boss.send(
      QUEUES.DRIP_JOBS,
      { enrollment_id: enrollment.id, step_id: nextStep.id },
      {
        id: `drip_${enrollment.id}_${nextStep.id}`,
        startAfterSeconds: delaySeconds,
        retryLimit: 2,
      }
    );
    
    console.log(`[DripWorker] Scheduled step ${nextStep.step_order} in ${nextStep.wait_days} days`);
  } else {
    // No more steps → Mark completed
    await supabase
      .from("sequence_enrollments")
      .update({ 
        status: "completed", 
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("id", enrollment.id);
      
    console.log(`[DripWorker] Sequence completed for enrollment ${enrollment_id}`);
  }

  return { success: true };
}