export function parseEbaySerpApiResult(result: any): Record<string, any> | null {
  if (!result || !result.title) return null;

  // FIX: SerpApi's eBay engine returns seller info under `seller`
  // ({ username, reviews, positive_feedback_in_percentage }), not
  // `seller_info`. Reading result.seller_info (always undefined) fell
  // through to the `result.seller` fallback — but that's the raw OBJECT,
  // not a string. It ended up assigned straight into name/company, which
  // is why the leads list showed raw JSON text like
  // {"username":"shopmotomentum","reviews":537600,...} instead of a name.
  const sellerName = result.seller?.username || null;
  const sellerReviews = result.seller?.reviews ?? null;
  const sellerPositivePct = result.seller?.positive_feedback_in_percentage ?? null;

  // FIX: price can be either a simple { raw, extracted } object OR a
  // range { from: {...}, to: {...} } for multi-variant listings. The old
  // code only handled the simple case — for range listings it fell all
  // the way through to `result.price` itself (the object), which then got
  // stringified wherever it was displayed. Now builds a proper string for
  // both shapes.
  let price: string | null = null;
  if (result.price?.raw) {
    price = result.price.raw;
  } else if (result.price?.from?.raw && result.price?.to?.raw) {
    price = `${result.price.from.raw} - ${result.price.to.raw}`;
  } else if (typeof result.price === "number") {
    price = `$${result.price}`;
  }

  // FIX: was looking for result.listing_info?.sold and result.extensions
  // (an array of plain strings) — neither exists in the actual response.
  // The real fields are quantity_sold / extracted_quantity_sold (and
  // sometimes stock_status, e.g. "Last one", "Almost gone").
  const soldCount =
    result.quantity_sold ||
    (result.extracted_quantity_sold != null ? `${result.extracted_quantity_sold} sold` : null) ||
    result.stock_status ||
    null;

  // Condition
  const condition = result.condition || null;

  // Category — not present per-item in the real response (only a
  // top-level `categories` list for the whole search), so this stays null
  // unless a future SerpApi response version adds it.
  const category = result.category || null;

  // FIX: shipping is usually a plain string ("Free delivery", "Free
  // delivery in 2-4 days") and sometimes an object ({ raw, extracted })
  // for paid shipping — never { free, cost } as the old code assumed.
  let shipsFrom: string | null = null;
  if (typeof result.shipping === "string") {
    shipsFrom = result.shipping;
  } else if (result.shipping?.raw) {
    shipsFrom = result.shipping.raw;
  }

  return {
    name: sellerName || result.title,
    company: sellerName || result.title,
    website: null,
    address: result.location || null,
    about: `${result.title}${condition ? ` — ${condition}` : ""}${price ? ` — ${price}` : ""}`,
    source: "ebay",
    extra_data: {
      product_title: result.title,
      ebay_url: result.link || null,
      item_id: result.product_id || null,
      price: price,
      condition: condition,
      category: category,
      ships_from: shipsFrom,
      item_sold_count: soldCount,
      seller_name: sellerName,
      seller_feedback_score: sellerReviews,
      seller_positive_percent: sellerPositivePct,
      thumbnail: result.thumbnail || null,
    },
  };
}
