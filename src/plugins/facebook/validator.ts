export function validateFacebookPage(page: Record<string, any>): Record<string, any> | null {
  if (!page.pageSlug) return null;

  if (page.followersCount !== null && page.followersCount < 0) page.followersCount = 0;

  if (page.website) {
    if (!/^https?:\/\//i.test(page.website) || page.website.includes("facebook.com")) {
      page.website = null;
    }
  }

  if (!page.name) page.name = page.pageSlug;

  return page;
}
