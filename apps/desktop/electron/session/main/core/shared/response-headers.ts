/**
 * Header primitives for webRequest.onHeadersReceived, where header names arrive
 * in whatever case the server sent and every value is an array.
 *
 * Shared by the embedded browser's local-development CORS relaxation and the
 * extension sandbox's per-host relaxation: both rewrite the same headers, and
 * two copies of this logic would drift.
 */

export type ResponseHeaders = Record<string, string[]>;

/** Sets a header, removing any existing spelling of the same name. */
export function setResponseHeader(headers: ResponseHeaders, name: string, value: string[]): void {
  deleteResponseHeader(headers, name);
  headers[name] = value;
}

export function deleteResponseHeader(headers: ResponseHeaders, name: string): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
  }
}

/** Adds a token to a comma-separated header (e.g. Vary) without duplicating it. */
export function appendResponseHeaderToken(
  headers: ResponseHeaders,
  name: string,
  token: string
): void {
  const existing = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase()
  );
  if (!existing) {
    headers[name] = [token];
    return;
  }

  const [existingName, values] = existing;
  const tokens = new Set(
    values
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter(Boolean)
  );
  tokens.add(token);
  headers[existingName] = [Array.from(tokens).join(', ')];
}

/** Case-insensitive lookup for request headers, which arrive as single strings. */
export function requestHeaderValue(
  headers: Record<string, string>,
  name: string
): string | undefined {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}
