import { sanitizeErrorSummary } from './error-summary'

export const ERROR_SUMMARY_PROTOCOL_VERSION = 1

/** Only the official intake route is accepted; GlitchTip DSNs stay server-side. */
export function errorSummaryDestination(endpoint: string): { url: string } | null {
  if (!endpoint.trim()) return null
  try {
    const parsed = new URL(endpoint)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/v1/beta-errors') return null
    return { url: parsed.toString() }
  } catch { return null }
}

/** Rebuild the five summary fields; never accept an SDK event or envelope. */
export function errorSummaryRequest(input: unknown): string | null {
  const summary = sanitizeErrorSummary(input)
  if (!summary || summary.version === 'unknown' || summary.system === 'unknown') return null
  return JSON.stringify({ schemaVersion: ERROR_SUMMARY_PROTOCOL_VERSION, summary })
}
