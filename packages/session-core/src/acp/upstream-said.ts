import { redactAll } from '@gugu/session-shared/logger';

const MAX_SAID_LENGTH = 280;

/**
 * The SDK's `RequestError.internalError(data, msg)` writes `Internal error: <msg>`
 * (`@agentclientprotocol/sdk` core/jsonrpc.js). The prefix is the protocol's; `<msg>` is the harness's.
 */
const JSON_RPC_INTERNAL_ERROR = /^Internal error:\s*/;
/**
 * Status line in front of an HTTP error body: codex's `unexpected status <code> <reason>: <body>` (codex-rs `error.rs`,
 * with `, url: …` and later parts dropped), or a bare `<code> {json}` as claude records `errorDetails`.
 */
const STATUS_LINE = /^(?:unexpected status \d{3}[^:]*:\s*([\s\S]*?)(?:,\s*url:\s[\s\S]*)?|\d{3}\s+(\{[\s\S]*\}))$/;

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The sentence the failing side said, as one line for the failed-turn row (#7103). **The only reader of failure text**:
 * the live `session/prompt` rejection and a turn failure decoded from any harness's record both go through it, so the
 * row says the same kind of thing however the transcript was built.
 *
 * Takes structured `data.message` over the text; unwraps the JSON-RPC internal-error prefix, an HTTP status line and an
 * `{"error":{"message"}}` / `{"message"}` body; keeps the first line, redacted (tokens, paths, IPs), capped by code
 * point. An HTML page (nginx in front of the gateway) or a JSON body without a message says nothing. Whether the text
 * is the provider's at all is the caller's call (a dropped connection is not a sentence anyone said).
 */
export function upstreamSaid(text: string, data?: unknown): string | undefined {
  const message = data && typeof data === 'object' ? (data as Record<string, unknown>).message : undefined;
  const trimmed = (typeof message === 'string' ? message : text).trim().replace(JSON_RPC_INTERNAL_ERROR, '');
  const status = STATUS_LINE.exec(trimmed);
  const body = status ? (status[1] ?? status[2]!).trim() : trimmed;
  const json = body.startsWith('{') ? parseJsonObject(body) : undefined;
  const nested = json?.error && typeof json.error === 'object' ? (json.error as Record<string, unknown>).message : undefined;
  const said = !json ? body
    : typeof nested === 'string' ? nested
    : typeof json.message === 'string' ? json.message
    : undefined;
  const line = said?.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
  if (!line || line.startsWith('<')) return undefined;
  return Array.from(redactAll(line)).slice(0, MAX_SAID_LENGTH).join('');
}
