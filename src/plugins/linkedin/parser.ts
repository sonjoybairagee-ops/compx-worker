export function parseLinkedinApifyResult(result: any): Record<string, any> | null {
  if (!result || !result.url) return null;

  // Apify typically returns emails, phoneNumbers, and websites as arrays
  const emails = Array.isArray(result.emails) ? result.emails : [];
  const phones = Array.isArray(result.phoneNumbers) ? result.phoneNumbers : [];
  const websites = Array.isArray(result.websites) ? result.websites : [];

  return {
    name: result.fullName || (result.firstName && result.lastName ? `${result.firstName} ${result.lastName}`.trim() : null),
    contactTitle: result.headline || result.occupation || null,
    company: result.currentCompany || result.company || null,
    address: result.location || result.geoLocation || null,
    linkedin: result.url,
    about: result.about || result.summary || "",
    email: emails.length > 0 ? emails[0] : null,
    phone: phones.length > 0 ? phones[0] : null,
    website: websites.length > 0 ? websites[0] : null,
    source: "linkedin",
    extra_data: {
      connections: result.connections || null,
      education: result.education || null,
    }
  };
}