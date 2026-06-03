import { supabase } from "@/lib/supabase";

export async function saveLead(orgId: string, lead: any) {
  return supabase.from("leads").insert([
    {
      org_id: orgId,
      company: lead.company,
      score: lead.score,
      status: "new",
    },
  ]);
}
