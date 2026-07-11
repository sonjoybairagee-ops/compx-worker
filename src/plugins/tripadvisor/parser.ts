export function parseTripadvisorSerpApiResult(result: any): Record<string, any> | null {
  // FIX: switched from Google-organic-result shape (title/link/snippet)
  // to the native Tripadvisor engine's `places` item shape (title/link/
  // place_id/place_type/description/rating/reviews/location/thumbnail).
  // Also enforces the link is an actual tripadvisor.com URL — the native
  // engine always returns those, but this stays as a safety check.
  if (!result || !result.title || !result.link || !result.link.includes("tripadvisor.com")) return null;

  const name = result.title.trim();

  return {
    name,
    company: name,
    website: null, // Will be found via enrichment
    linkedin: null,
    tripadvisor: result.link,
    // FIX: rating/reviews/about must be TOP-LEVEL — leadRawNormalize.ts's
    // normalizeTripadvisorRaw() reads raw.rating / raw.reviews (or
    // raw.review_count) / raw.about directly off the top-level raw
    // object, not from extra_data. The old parser only put these inside
    // extra_data, so the modal always showed them empty even when the
    // values existed.
    rating: result.rating ?? null,
    reviews: result.reviews ?? null,
    about: result.description || null,
    address: result.location || null,
    source: "tripadvisor",
    extra_data: {
      place_id: result.place_id || null,
      place_type: result.place_type || null,
      rating: result.rating ?? null,
      reviews: result.reviews ?? null,
      thumbnail: result.thumbnail || null,
    }
  };
}
