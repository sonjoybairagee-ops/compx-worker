const { config } = require("dotenv");
const path = require("path");

config({ path: path.join(__dirname, ".env") });

async function testEbayParam() {
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) {
    console.log("No API key");
    return;
  }

  const url = new URL("https://serpapi.com/search");
  url.searchParams.set("engine", "ebay");
  url.searchParams.set("_nkw", "laptop");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("LH_SellerWithStore", "1");

  const res = await fetch(url.toString());
  const data = await res.json();
  
  if (data.organic_results && data.organic_results.length > 0) {
    console.log("Found", data.organic_results.length, "results with LH_SellerType=1");
    console.log("First result:", data.organic_results[0].seller_info || data.organic_results[0].title);
  } else {
    console.log("No results or error", data);
  }
}

testEbayParam();
