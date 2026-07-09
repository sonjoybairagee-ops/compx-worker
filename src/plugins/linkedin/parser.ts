export function parseLinkedinApifyResult(result: any): Record<string, any> | null {
  if (!result || !result.url) return null;

  return {
    name: result.fullName || result.firstName + " " + result.lastName || null,
    contactTitle: result.headline || null,
    company: result.company || result.currentCompany || null,
    address: result.location || null,
    linkedin: result.url,
    about: result.about || result.summary || "",
    source: "linkedin",
  };
}
