import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { LOCAL_DIAGNOSTICS_SCOPE, MEMORY_SAMPLE_INTERVAL, sanitizeDiagnosticFields } from '../shared/local-renderer-diagnostics'
import { createLogger, currentLogFile, writeRendererLog } from './lib/logger'

interface Sender { id: number; getOSProcessId(): number }
interface Metric { pid: number; memory: { workingSetSize: number; peakWorkingSetSize?: number }; cpu?: { cumulativeCPUUsage?: number } }
interface Dependencies {
  getMetrics(): Metric[]
  logFile?: () => string | null
  regular?: typeof writeRendererLog
  maxBytes?: number
  onError?: () => void
}

/** Dedicated rotating file: never part of feedback:log-tail, stdout, or an upload path. */
export function createRendererLogForwarder(deps: Dependencies) {
  const budgets = new WeakMap<Sender, { start: number; count: number; dropped: number; memoryAt: number }>()
  let reportedFailure = false
  return (sender: Sender, payload: unknown): void => {
    try {
      const source = { rendererPid: sender.getOSProcessId(), webContentsId: sender.id }
      const p = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
      if (p.scope !== LOCAL_DIAGNOSTICS_SCOPE) {
        (deps.regular ?? writeRendererLog)(payload, source)
        return
      }
      const fields = sanitizeDiagnosticFields(p.fields)
      if (!fields) return
      const base = (deps.logFile ?? currentLogFile)()
      if (!base) return
      const time = Date.now()
      let budget = budgets.get(sender)
      if (!budget) { budget = { start: time, count: 0, dropped: 0, memoryAt: -Infinity }; budgets.set(sender, budget) }
      const dropped = time - budget.start >= 60_000 ? budget.dropped : 0
      if (time - budget.start >= 60_000) { budget.start = time; budget.count = 0; budget.dropped = 0 }
      if (fields.event === 'memory') {
        if (time - budget.memoryAt < MEMORY_SAMPLE_INTERVAL) return
        budget.memoryAt = time
        const bytes = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value * 1024 : null
        try {
          const metric = deps.getMetrics().find(row => row.pid === source.rendererPid)
          fields.nativeMemory = metric ? { workingSetBytes: bytes(metric.memory.workingSetSize), peakWorkingSetBytes: bytes(metric.memory.peakWorkingSetSize) } : null
        } catch { fields.nativeMemory = null }
      } else if (budget.count++ >= 60) { budget.dropped++; return }
      const file = join(dirname(base), 'gugu-ui-diagnostics.log')
      const line = JSON.stringify({ time, ...source, ...fields, ...(dropped ? { ipcSuppressed: dropped } : {}) }) + '\n'
      mkdirSync(dirname(file), { recursive: true })
      if (existsSync(file) && statSync(file).size + Buffer.byteLength(line) > (deps.maxBytes ?? 1024 * 1024)) {
        if (existsSync(`${file}.2`)) unlinkSync(`${file}.2`)
        if (existsSync(`${file}.1`)) renameSync(`${file}.1`, `${file}.2`)
        renameSync(file, `${file}.1`)
      }
      appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 })
    } catch {
      if (!reportedFailure) {
        reportedFailure = true
        try {
          if (deps.onError) deps.onError()
          else createLogger('diagnostics').warn('Local renderer diagnostic sink unavailable')
        } catch { /* Even reporting a sink failure cannot reject an input callback. */ }
      }
    }
  }
}
