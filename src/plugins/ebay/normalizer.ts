export function normalizeEbayProfile(profile: Record<string, any>): Record<string, any> {
  const normalized = { ...profile };

  // FIX: was checking extra_data.product_price — that's Amazon's field
  // name (this file was copy-pasted from normalizeAmazonProfile and never
  // updated). eBay's parser.ts sets extra_data.price, not
  // extra_data.product_price, so this normalization never actually ran —
  // eBay prices stayed as raw strings/objects instead of being converted
  // to a number.
  if (normalized.extra_data?.price) {
    let price = normalized.extra_data.price;
    if (typeof price === 'string') {
      price = price.replace(/[^0-9.]/g, '');
      if (price) {
        normalized.extra_data.price = parseFloat(price);
      }
    }
  }

  // item_sold_count and seller_feedback_score/seller_positive_percent can
  // also arrive as raw text (e.g. "5,000+ sold", "98.5% positive") per
  // parser.ts's comments — normalize those to numbers here too, so
  // anything filtering/sorting/displaying them doesn't have to re-parse
  // text on every read.
  if (typeof normalized.extra_data?.item_sold_count === 'string') {
    const n = parseFloat(normalized.extra_data.item_sold_count.replace(/[^0-9.]/g, ''));
    if (!isNaN(n)) normalized.extra_data.item_sold_count = n;
  }
  if (typeof normalized.extra_data?.seller_feedback_score === 'string') {
    const n = parseFloat(normalized.extra_data.seller_feedback_score.replace(/[^0-9.]/g, ''));
    if (!isNaN(n)) normalized.extra_data.seller_feedback_score = n;
  }
  if (typeof normalized.extra_data?.seller_positive_percent === 'string') {
    const n = parseFloat(normalized.extra_data.seller_positive_percent.replace(/[^0-9.]/g, ''));
    if (!isNaN(n)) normalized.extra_data.seller_positive_percent = n;
  }

  return normalized;
}
