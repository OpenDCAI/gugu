import {
  appendResponseHeaderToken,
  requestHeaderValue,
  setResponseHeader,
  type ResponseHeaders,
} from '@main/core/shared/response-headers';

export type BrowserCorsRequestHeaders = Record<string, string>;
export type BrowserCorsResponseHeaders = ResponseHeaders;

export type BrowserCorsRelaxationRequest = {
  origin: string;
  requestedMethod?: string;
  requestedHeaders?: string;
};

const DEFAULT_ALLOWED_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD';

export function localDevelopmentCorsRelaxationRequest(
  requestHeaders: BrowserCorsRequestHeaders
): BrowserCorsRelaxationRequest | null {
  const origin = headerValue(requestHeaders, 'origin');
  if (!origin || !isLocalDevelopmentOrigin(origin)) return null;

  return {
    origin,
    requestedMethod: headerValue(requestHeaders, 'access-control-request-method'),
    requestedHeaders: headerValue(requestHeaders, 'access-control-request-headers'),
  };
}

export function applyLocalDevelopmentCorsRelaxation(
  responseHeaders: BrowserCorsResponseHeaders,
  request: BrowserCorsRelaxationRequest
): BrowserCorsResponseHeaders {
  const next = { ...responseHeaders };
  setResponseHeader(next, 'Access-Control-Allow-Origin', [request.origin]);
  setResponseHeader(next, 'Access-Control-Allow-Credentials', ['true']);
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

function headerValue(headers: BrowserCorsRequestHeaders, name: string): string | undefined {
  return requestHeaderValue(headers, name);
}

function isLocalDevelopmentOrigin(value: string): boolean {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    return false;
  }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false;
  return isLocalDevelopmentHost(origin.hostname);
}

function isLocalDevelopmentHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]'
  );
}
