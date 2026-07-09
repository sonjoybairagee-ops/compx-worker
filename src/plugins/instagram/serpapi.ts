import { ProviderError, ProviderErrorType } from "@compx/scraper-core";

export interface InstagramFilters {
  searchType?: string;
  followers?: string;
  industry?: string;
  businessOnly?: boolean;
  hasWebsite?: boolean;
  hasPublicEmail?: boolean;
}

// Google site:search — no native API params for these, so businessOnly/
// industry get folded into the query text. followers/hasWebsite/
// hasPublicEmail can't be applied here at all; they need to be
// post-filtered in plugins/instagram/index.ts after normalization.
export async function fetchInstagramSerpApi(
  keyword: string,
  location?: string,
  filters: InstagramFilters = {}
): Promise<any[]> {
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) throw new ProviderError(ProviderErrorType.UNAUTHORIZED, "SERPAPI_API_KEY is not configured");

  const parts = [keyword];
  if (location) parts.push(location);
  if (filters.industry?.trim()) parts.push(filters.industry.trim());
  if (filters.businessOnly) parts.push("business");
  const query = parts.join(" ");

  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query + " site:instagram.com")}&api_key=${apiKey}&num=50`;

  let response;
  try {
    response = await fetch(url);
  } catch (err: any) {
    throw new ProviderError(ProviderErrorType.TIMEOUT, `SerpApi fetch failed: ${err.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new ProviderError(ProviderErrorType.UNAUTHORIZED, "Invalid SerpApi Key");
  }
  if (response.status === 402) {
    throw new ProviderError(ProviderErrorType.PAYMENT_REQUIRED, "SerpApi out of credits");
  }
  if (response.status === 429) {
    throw new ProviderError(ProviderErrorType.RATE_LIMIT, "SerpApi rate limit exceeded");
  }
  if (!response.ok) {
    throw new ProviderError(ProviderErrorType.SERVER_ERROR, `SerpApi HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!data.organic_results || data.organic_results.length === 0) {
    throw new ProviderError(ProviderErrorType.EMPTY_RESULT, "No results found on SerpApi");
  }

  return data.organic_results;
}
