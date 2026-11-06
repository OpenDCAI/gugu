export class CredentialWebsiteError extends Error {
  constructor() { super('credential_website_unavailable'); }
}

/** No URLs, queries or lower-layer errors are returned in validation failures. */
function httpsUrl(value: string): URL {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/.test(value)) throw new CredentialWebsiteError();
  let url: URL;
  try { url = new URL(value); } catch { throw new CredentialWebsiteError(); }
  if (url.protocol !== 'https:' || !url.hostname || url.hostname.includes('*') || url.username || url.password) throw new CredentialWebsiteError();
  return url;
}

/** Canonical scheme, hostname and effective port; never a suffix/wildcard comparison. */
export function credentialWebsiteOrigin(value: string): string {
  return httpsUrl(value).origin;
}

export function assertCredentialWebsite(actualUrl: string, expectedOrigin: string): void {
  const expected = httpsUrl(expectedOrigin);
  if (expectedOrigin !== expected.origin || httpsUrl(actualUrl).origin !== expected.origin) throw new CredentialWebsiteError();
}
