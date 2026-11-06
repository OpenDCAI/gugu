import { sanitizeErrorSummary, type ErrorSummary } from './error-summary'

export interface ReportingContext { eligible: boolean; allowed: boolean; scope: string | undefined }
export interface PendingErrorSummary { scope: string; summary: ErrorSummary }

/** Sanitized before persistence, then rebuilt from the allowlist immediately before send. */
export function createErrorSummaryReporter(deps: {
  configured: boolean
  context: () => ReportingContext
  read: () => unknown
  save: (pending: PendingErrorSummary[]) => void
  send: (summary: ErrorSummary, signal: AbortSignal) => Promise<void>
  now: () => number
}) {
  let pending: PendingErrorSummary[] = []
  let generation = 0
  let active: AbortController | null = null
  let flushing = false
  const recent = new Map<string, number>()
  const valid = (context: ReportingContext) => deps.configured && context.eligible && context.allowed && context.scope !== undefined
  const save = () => { deps.save(pending) }
  const clear = () => {
    generation++
    active?.abort()
    pending = []
    recent.clear()
    save()
  }
  const hydrate = () => {
    const context = deps.context()
    if (!valid(context)) return
    const disk = deps.read()
    if (!Array.isArray(disk) || disk.length > 20) { clear(); return }
    pending = disk.flatMap(row => {
      if (!row || typeof row !== 'object' || row.scope !== context.scope) return []
      const summary = sanitizeErrorSummary(row.summary)
      if (!summary || deps.now() - Date.parse(summary.time) > 86_400_000 || Date.parse(summary.time) > deps.now() + 60_000) return []
      return [{ scope: context.scope!, summary }]
    })
    save()
  }
  const flush = async () => {
    if (flushing || !deps.configured) return
    flushing = true
    const token = generation
    try {
      while (pending.length && token === generation) {
        const context = deps.context()
        const row = pending[0]
        if (!valid(context) || row.scope !== context.scope) { clear(); return }
        const summary = sanitizeErrorSummary(row.summary)
        if (!summary || deps.now() - Date.parse(summary.time) > 86_400_000 || Date.parse(summary.time) > deps.now() + 60_000) { pending.shift(); save(); continue }
        active = new AbortController()
        try { await deps.send(summary, active.signal) } catch { return }
        if (token !== generation) return
        pending.shift()
        save()
      }
    } catch { /* A storage failure must not become another reported rejection. */ } finally { active = null; flushing = false }
  }
  return {
    report(input: unknown) {
      const context = deps.context()
      if (!valid(context)) return
      const summary = sanitizeErrorSummary(input)
      if (!summary) return
      const fingerprint = JSON.stringify([summary.type, summary.locations, summary.version, summary.system])
      const now = deps.now()
      for (const [key, at] of recent) if (now - at >= 60_000) recent.delete(key)
      if (recent.has(fingerprint) || recent.size >= 20 || pending.length >= 20) return
      recent.set(fingerprint, now)
      pending.push({ scope: context.scope!, summary })
      // Synchronous write lets a fatal handler exit without waiting for the network.
      try { save() } catch { pending.pop(); recent.delete(fingerprint); return }
      void flush()
    },
    changed() { clear() },
    start() { if (deps.configured) { hydrate(); void flush() } },
    flush,
    pending: () => structuredClone(pending),
  }
}
