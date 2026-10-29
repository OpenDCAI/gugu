// Network events also carry HttpOnly credentials in nested headers, cookie metadata and raw
// header text. Make a separate value for App listeners; never mutate the native event object.
const COOKIE_FIELDS = new Set(['cookie', 'set-cookie', 'associatedcookies', 'blockedcookies', 'exemptedcookies', 'cookieline']);

function withoutCookies(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCookies);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !COOKIE_FIELDS.has(key.toLowerCase())).map(([key, item]) => [
    key,
    key.toLowerCase() === 'headerstext' && typeof item === 'string'
      ? item.replace(/^(?:cookie|set-cookie)[ \t]*:[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*(?:\r?\n|$)/gim, '')
      : withoutCookies(item),
  ]));
}

export function pageNetworkEvent(method: string, params: Record<string, unknown>): Record<string, unknown> {
  return method.startsWith('Network.') ? withoutCookies(params) as Record<string, unknown> : params;
}
