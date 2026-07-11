/** plugins/facebook/providers/serpapi.ts — moved from facebook/serpapi.ts, unchanged behavior. */
import { ProviderError, ProviderErrorType } from "@compx/scraper-core";
import type { SourceProvider, ProviderRunContext } from "@compx/scraper-core";

export interface FacebookProviderInput {
  keyword: string;
  location?: string;
}

async function fetchFacebookSerpApi(input: FacebookProviderInput, _ctx: ProviderRunContext): Promise<any[]> {
  const { keyword, location } = input;
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) throw new ProviderError(ProviderErrorType.UNAUTHORIZED, "SERPAPI_API_KEY is not configured");

  const query = location ? `${keyword} ${location}` : keyword;
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query + " site:facebook.com")}&api_key=${apiKey}&num=50`;

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

export const facebookSerpApiProvider: SourceProvider<FacebookProviderInput, any> = {
  name: "facebook-serpapi",
  fetch: fetchFacebookSerpApi,
};
