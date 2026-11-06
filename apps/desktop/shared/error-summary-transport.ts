import { sanitizeErrorSummary } from './error-summary'

/** No SDK is initialized: this transport has no automatic context collectors. */
export function errorSummaryDestination(dsn: string): { url: string; authorization: string } | null {
  if (!dsn.trim()) return null
  try {
    const parsed = new URL(dsn)
    if (parsed.protocol !== 'https:' || parsed.password || parsed.search || parsed.hash || !/^[A-Za-z0-9]{1,128}$/.test(parsed.username)) return null
    const parts = parsed.pathname.split('/').filter(Boolean)
    const project = parts.pop()
    if (!project || !/^\d+$/.test(project)) return null
    const key = parsed.username
    parsed.username = ''
    parsed.pathname = `/${[...parts, 'api', project, 'envelope'].join('/')}/`
    return { url: parsed.toString(), authorization: `Sentry sentry_version=7,sentry_key=${key},sentry_client=gugu-error-summary/1` }
  } catch { return null }
}

/** Protocol wrapper contains only constants and fields rebuilt from the summary. */
export function errorSummaryEnvelope(input: unknown, eventId: string): string | null {
  const summary = sanitizeErrorSummary(input)
  if (!summary || !/^[a-f0-9]{32}$/.test(eventId)) return null
  const frames = summary.locations.map(location => {
    const match = location.match(/^(.*?)(?::(\d+))?(?::(\d+))?$/)!
    return { filename: match[1], ...(match[2] ? { lineno: Number(match[2]) } : {}), ...(match[3] ? { colno: Number(match[3]) } : {}), in_app: true }
  }).reverse()
  const event = {
    event_id: eventId,
    timestamp: summary.time,
    platform: 'javascript',
    release: summary.version,
    contexts: { os: { name: summary.system } },
    exception: { values: [{ type: summary.type, ...(frames.length ? { stacktrace: { frames } } : {}) }] },
  }
  return `${JSON.stringify({ event_id: eventId })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`
}
