import { calculateLeadScore } from "@/lib/intelligence/score";
import { classifyLead } from "@/lib/intelligence/classify";

export function enrichLead(lead: any) {
  const classification = classifyLead(lead);

  const enriched = {
    ...lead,
    ...classification,
    lead_score: calculateLeadScore({
      ...lead,
      ...classification,
    }),
  };

  return enriched;
}
