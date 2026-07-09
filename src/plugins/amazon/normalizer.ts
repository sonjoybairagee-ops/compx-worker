export function normalizeAmazonProfile(profile: Record<string, any>): Record<string, any> {
  const normalized = { ...profile };
  
  if (normalized.extra_data?.product_price) {
    let price = normalized.extra_data.product_price;
    if (typeof price === 'string') {
      price = price.replace(/[^0-9.]/g, '');
      if (price) {
        normalized.extra_data.product_price = parseFloat(price);
      }
    }
  }

  return normalized;
}
