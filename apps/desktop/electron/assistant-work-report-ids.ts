import { createHash } from 'node:crypto'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a < b ? -1 : a > b ? 1 : 0).map(([key,item])=>[key,canonical(item)]))
  return value
}

/** Same immutable report intent retains both IDs across request retries and host restarts. */
export function createDesktopWorkReportIds(sessionId: string, report: Record<string, unknown>): () => string {
  const intent = JSON.stringify(['desktop-work-report',sessionId,canonical(report)])
  let sequence = 0
  return () => {
    const hex = createHash('sha256').update(JSON.stringify([intent,sequence++])).digest('hex')
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`
  }
}
