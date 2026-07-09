export function parseTripadvisorSerpApiResult(result: any): Record<string, any> | null {
  if (!result || !result.title || !result.link) return null;

  return {
    name: result.title.replace(/ - Tripadvisor.*/, "").trim(),
    company: result.title.replace(/ - Tripadvisor.*/, "").trim(),
    website: null, // Will be found via enrichment
    linkedin: null,
    tripadvisor: result.link,
    about: result.snippet || null,
    source: "tripadvisor",
    extra_data: {
      rating: result.rating || null,
      reviews: result.reviews || null,
    }
  };
}
