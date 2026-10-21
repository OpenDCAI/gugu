import {
  appendResponseHeaderToken,
  requestHeaderValue,
  setResponseHeader,
  type ResponseHeaders,
} from '@main/core/shared/response-headers';
import { isLoopbackOrPrivateHost } from '@shared/extensions/manifest';
import { EXTENSION_SCHEME, networkHostAllowed } from '@shared/extensions/partition';

/**
 * What an extension's sandbox may reach on the network, decided from the hosts
 * its manifest declared. Pure so the policy can be tested exhaustively without
 * an electron session; the session module below applies it. Refs #2374.
 */

/**
 * Schemes that move no data off the machine, so they are not the network
 * permission's business: the extension's own bundle, values the page itself
 * produced (data:/blob:), and DevTools.
 */
const NON_NETWORK_SCHEMES: ReadonlySet<string> = new Set([
  `${EXTENSION_SCHEME}:`,
  'data:',
  'blob:',
  'about:',
  'devtools:',
]);

export type NetworkDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'unparsable-url' | 'scheme-not-allowed' | 'host-not-declared' | 'local-host';
    };

/**
 * Decides a single request.
 *
 * https only: an extension that declared `api.example.com` asked to talk to
 * that host, not to whoever answers on the unencrypted port. Allowing http and
 * then trying to compensate elsewhere would be the patch this avoids.
 */
export function decideExtensionRequest(
  url: string,
  declaredHosts: readonly string[]
): NetworkDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: 'unparsable-url' };
  }

  if (NON_NETWORK_SCHEMES.has(parsed.protocol)) return { allowed: true };
  // wss: rides the same allowlist as https; ws: is refused with http:.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'wss:') {
    return { allowed: false, reason: 'scheme-not-allowed' };
  }
  // Checked per request, not only at install: a wildcard covers subdomains
  // nobody enumerated, and a redirect reaches whatever it names. Declaring
  // `*.example.com` must not become a way to reach 10.0.0.5 by CNAME.
  if (isLoopbackOrPrivateHost(parsed.hostname)) {
    return { allowed: false, reason: 'local-host' };
  }
  if (!networkHostAllowed(declaredHosts, parsed.hostname)) {
    return { allowed: false, reason: 'host-not-declared' };
  }
  return { allowed: true };
}

export type ExtensionCorsRequest = {
  origin: string;
  requestedMethod?: string;
  requestedHeaders?: string;
};

const DEFAULT_ALLOWED_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD';

/**
 * A cross-origin fetch from gugu-ext://<id> would be refused by CORS no matter
 * what the allowlist says — no public API returns Access-Control-Allow-Origin
 * for a custom scheme. Since the host has already decided this extension may
 * talk to this host, the host is also what grants it, by answering the CORS
 * question itself. This is the same grant Chrome performs internally for an
 * extension's host_permissions.
 *
 * Returns null when the request is not the extension reaching out cross-origin,
 * so nothing else on the session gets rewritten.
 */
export function extensionCorsRequest(
  requestHeaders: Record<string, string>,
  extensionId: string
): ExtensionCorsRequest | null {
  const origin = requestHeaderValue(requestHeaders, 'origin');
  if (!origin || origin !== `${EXTENSION_SCHEME}://${extensionId}`) return null;
  return {
    origin,
    requestedMethod: requestHeaderValue(requestHeaders, 'access-control-request-method'),
    requestedHeaders: requestHeaderValue(requestHeaders, 'access-control-request-headers'),
  };
}

/**
 * Grants the extension origin read access to a response the allowlist already
 * permitted. Credentials are NOT allowed: the extension may talk to a declared
 * host, it may not ride the user's cookies for it.
 */
export function applyExtensionCorsGrant(
  responseHeaders: ResponseHeaders,
  request: ExtensionCorsRequest
): ResponseHeaders {
  const next = { ...responseHeaders };
  setResponseHeader(next, 'Access-Control-Allow-Origin', [request.origin]);
  setResponseHeader(next, 'Access-Control-Allow-Methods', [
    request.requestedMethod ?? DEFAULT_ALLOWED_METHODS,
  ]);
  if (request.requestedHeaders) {
    setResponseHeader(next, 'Access-Control-Allow-Headers', [request.requestedHeaders]);
  }
  if (request.requestedMethod) {
    setResponseHeader(next, 'Access-Control-Max-Age', ['86400']);
  }
  appendResponseHeaderToken(next, 'Vary', 'Origin');
  return next;
}
