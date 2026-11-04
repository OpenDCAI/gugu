/**
 * Whether a manifest network host pattern covers a hostname.
 * `*.example.com` covers example.com and any subdomain (Chrome's match
 * semantics); a bare host matches only itself. Comparison is case-insensitive;
 * a trailing dot (the DNS root, `example.com.`) resolves to the same host and
 * must not be a way around the list.
 */
export function networkHostMatches(pattern: string, hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const rule = pattern.toLowerCase();
  if (rule.startsWith('*.')) {
    const base = rule.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }
  return host === rule;
}

/** Whether any declared host pattern covers this hostname. */
export function networkHostAllowed(patterns: readonly string[], hostname: string): boolean {
  return patterns.some((pattern) => networkHostMatches(pattern, hostname));
}

/** Explain a refusal using the manifest and the person's current grant. */
export function networkHostVerdict(declared: readonly string[], granted: readonly string[], host: string): 'allowed' | 'withdrawn' | 'not-declared' {
  if (networkHostAllowed(granted, host)) return 'allowed';
  return networkHostAllowed(declared, host) ? 'withdrawn' : 'not-declared';
}
