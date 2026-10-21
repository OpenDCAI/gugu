/**
 * Content-Security-Policy served with every extension resource — by the desktop's `gugu-ext://` protocol handler and by
 * the phone's shell, for each App in its own origin (L9): one policy, so an App meets the same rules on both.
 *
 * This is what makes "what you installed is what runs" true: an App's code comes only from
 * its bundle, and the one other script in the page is the platform runtime, served from
 * gugu's own files under the reserved `/_gugu/` path (read-only, shipped with this build,
 * not overridable by a bundle). script-src 'self'
 * admits only those — no remote script, and with no
 * 'unsafe-eval' the string-to-code paths are out too. connect-src is narrowed
 * per extension to the hosts its manifest declares; the session-level block is
 * the real enforcement (a page cannot lift that), and this header makes the
 * same rule visible to the extension author as a console error rather than a
 * silent failure.
 *
 * style-src keeps 'unsafe-inline': inline styles execute no code, and every
 * mainstream UI toolkit emits them.
 *
 * `framedBy` is the one origin that may embed the page: on the desktop the App's own (it is the top of its webview);
 * on the phone the gugu page whose iframe it runs in.
 */
export function extensionContentSecurityPolicy(framedBy: string, networkHosts: readonly string[]): string {
  // Mirrors what the session actually permits, or the header would refuse
  // requests the enforcement layer allows and the author would chase a
  // contradiction: wss rides the same allowlist as https, and `*.host` covers
  // the apex, which CSP's own wildcard does not.
  const expand = (scheme: string) =>
    networkHosts.flatMap((host) => {
      const hosts = host.startsWith('*.') ? [host, host.slice(2)] : [host];
      return hosts.map((entry) => `${scheme}://${entry}`);
    });
  const httpsSources = expand('https');
  const connectSources = ["'self'", ...httpsSources, ...expand('wss')];
  // A declared host may also be the source of pictures and fonts, not only of
  // fetches. The session layer never looked at resource type — it permits https
  // to a declared host whatever the request is for — so a header that allowed
  // `fetch()` and refused `<img>` from the same host was this file contradicting
  // itself, and the author chasing a rule nothing states. Code stays pinned to
  // the bundle regardless: script-src is 'self' and nothing widens it.
  const assetSources = ["'self'", ...httpsSources];
  return [
    `default-src 'self'`,
    `script-src 'self'`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src ${assetSources.join(' ')} data: blob:`,
    `font-src ${assetSources.join(' ')} data:`,
    `media-src ${assetSources.join(' ')} blob:`,
    `connect-src ${connectSources.join(' ')}`,
    `frame-src 'none'`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'none'`,
    `frame-ancestors ${framedBy}`,
  ].join('; ');
}
