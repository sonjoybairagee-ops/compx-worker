import { sendEmail } from "@/lib/actions/email";

export async function runCampaign(campaign: any, leads: any[]) {
  for (const lead of leads) {
    await sendEmail(lead, campaign);

    console.log("Sent to:", lead.email);
  }

  return {
    status: "completed",
    sent: leads.length,
  };
}
