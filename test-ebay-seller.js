import fetch from "node-fetch";

async function testSellerPage() {
  const sellerUrl = "https://www.ebay.com/usr/vipoutlet"; // Example large seller
  const res = await fetch(sellerUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
  });
  const text = await res.text();
  
  if (text.includes("Business seller information") || text.includes("Business seller")) {
    console.log("Found Business seller indicators!");
  }
  if (text.includes("Top Rated Plus") || text.includes("Top Rated Seller") || text.includes("Top-Rated Seller")) {
    console.log("Found Top Rated indicators!");
  }
  
  // also try item page
  const itemUrl = "https://www.ebay.com/itm/1234567890"; // fake item
  // actually, fetching an item page might be easier if we have the item_id.
}
testSellerPage();
