export function validateFacebookPage(page: Record<string, any>): Record<string, any> | null {
  if (!page.pageSlug) return null;

  // Sanitize numeric fields
  if (page.followersCount !== null && page.followersCount < 0) page.followersCount = 0;

  // FIX: Validate and normalize website
  if (page.website) {
    let url = page.website.trim();
    // Ensure it has a protocol
    if (!/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }
    
    // Reject internal social media links
    const IGNORE_DOMAINS = ['facebook.com', 'instagram.com', 'youtube.com', 'twitter.com', 'x.com', 'tiktok.com', 'linkedin.com'];
    const isSocial = IGNORE_DOMAINS.some(d => url.includes(d));
    
    if (isSocial) {
      page.website = null;
    } else {
      page.website = url;
    }
  }

  // Ensure minimum viable data
  if (!page.name) page.name = page.pageSlug;
  if (!page.company) page.company = page.name;

  return page;
}