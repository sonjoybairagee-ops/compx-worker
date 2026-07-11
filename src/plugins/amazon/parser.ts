export function parseAmazonSerpApiResult(result: any): Record<string, any> | null {
  if (!result || !result.title) return null;

  return {
    name: result.title,
    company: result.title,
    website: null,
    linkedin: null,
    address: null,
    about: result.description || null,
    source: "amazon",
    extra_data: {
      asin: result.asin || null,
      product_price: result.price?.raw || result.price || null,
      product_rating: result.rating || null,
      product_reviews: result.reviews || null,
      amazon_url: result.link || null,
    }
  };
}
