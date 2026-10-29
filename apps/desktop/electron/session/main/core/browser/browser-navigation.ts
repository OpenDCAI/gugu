import { normalizeBrowserUrl } from '@shared/browser';

export function isSupportedBrowserNavigationUrl(url: string): boolean {
  return normalizeBrowserUrl(url, { allowSearchQueries: false }).ok;
}
