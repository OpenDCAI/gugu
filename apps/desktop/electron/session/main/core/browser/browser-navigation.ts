import { normalizeBrowserUrl } from '@shared/browser';

export function isSupportedBrowserNavigationUrl(url: string): boolean {
  // Chromium strips URL controls before recognizing the scheme; never validate a different URL.
  return !/\p{Cc}/u.test(url) && normalizeBrowserUrl(url, { allowSearchQueries: false }).ok;
}
