export function parseEbaySerpApiResult(result: any): Record<string, any> | null {
  if (!result || !result.title) return null;

  // SerpApi eBay engine returns organic_results with these fields:
  // title, link, condition, price (object), seller_info, listing_info, shipping, item_id, thumbnail
  const price = result.price?.raw || result.price?.extracted || result.price || null;
  
  // Seller info — SerpApi sometimes returns seller_info object
  const sellerName = result.seller_info?.name || result.seller_info?.link?.split("/").pop() || result.seller || null;
  const sellerFeedback = result.seller_info?.feedback || null;
  const sellerPositivePct = result.seller_info?.positive_feedback_percent || null;
  
  // Sold count from listing_info
  const soldCount = result.listing_info?.sold || result.extensions?.find((e: string) => /sold/i.test(e)) || null;
  
  // Condition
  const condition = result.condition || (result.extensions && result.extensions.find((e: string) => /new|used|refurb/i.test(e))) || null;
  
  // Category
  const category = result.category || null;
  
  // Ships from
  const shipsFrom = result.shipping?.free ? "Free Shipping" : result.shipping?.cost ? `Ships: ${result.shipping.cost}` : null;

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
      item_id: result.item_id || null,
      price: price,
      condition: condition,
      category: category,
      ships_from: shipsFrom,
      item_sold_count: soldCount,
      seller_name: sellerName,
      seller_feedback_score: sellerFeedback,
      seller_positive_percent: sellerPositivePct,
      thumbnail: result.thumbnail || null,
    },
  };
}
