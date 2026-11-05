import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRendererLogForwarder } from '../../../../apps/desktop/electron/local-renderer-diagnostics'
import { LOCAL_DIAGNOSTICS_SCOPE, MEMORY_SAMPLE_INTERVAL } from '../../../../apps/desktop/shared/local-renderer-diagnostics'
import { initLogging, readLogTailForFeedback, resetLoggingForTests } from '../../../../apps/desktop/electron/lib/logger'

afterEach(() => { vi.useRealTimers(); resetLoggingForTests() })
const sender = () => ({ id: 17, getOSProcessId: () => 1234 })
const payload = (fields: Record<string, unknown>) => ({ scope: LOCAL_DIAGNOSTICS_SCOPE, fields })
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'gugu-local-diag-'))
  return { dir, file: join(dir, 'gugu-ui-diagnostics.log'), main: join(dir, 'gugu-main.log') }
}

describe('local-only renderer diagnostic sink', () => {
  it('uses real sender identity, allowlists fields and routes ordinary logs normally', () => {
    const f = fresh(), regular = vi.fn(), metrics = vi.fn(() => [])
    const forward = createRendererLogForwarder({ logFile: () => f.main, regular, getMetrics: metrics })
    const source = sender()
    forward(source, { scope: 'ordinary', fields: { rendererPid: 9999 } })
    expect(regular).toHaveBeenCalledWith({ scope: 'ordinary', fields: { rendererPid: 9999 } }, { rendererPid: 1234, webContentsId: 17 })
    forward(source, payload({ event: 'escape', at: 10, rendererPid: 9999, message: 'private message', title: 'private title' }))
    const row = JSON.parse(readFileSync(f.file, 'utf8').trim())
    expect(row).toMatchObject({ rendererPid: 1234, webContentsId: 17, event: 'escape', at: 10 })
    expect(JSON.stringify(row)).not.toContain('private')
    expect(metrics).not.toHaveBeenCalled()
    expect(regular).toHaveBeenCalledTimes(1)
  })

  it('keeps JS bytes and native working set/peak bytes separate and gates native reads to five minutes', () => {
    vi.useFakeTimers()
    const f = fresh(), metrics = vi.fn(() => [{ pid: 1234, memory: { workingSetSize: 1024, peakWorkingSetSize: 2048 } }])
    const forward = createRendererLogForwarder({ logFile: () => f.main, getMetrics: metrics })
    const source = sender()
    forward(source, payload({ event: 'memory', usedHeapBytes: 55 }))
    forward(source, payload({ event: 'memory', usedHeapBytes: 66 }))
    expect(metrics).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(MEMORY_SAMPLE_INTERVAL)
    forward(source, payload({ event: 'memory', usedHeapBytes: 77 }))
    const rows = readFileSync(f.file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ usedHeapBytes: 55, nativeMemory: { workingSetBytes: 1048576, peakWorkingSetBytes: 2097152 } })
    expect(rows[1].usedHeapBytes).toBe(77)
  })

  it('bounds IPC floods and files and records the suppressed count', () => {
    vi.useFakeTimers()
    const f = fresh(), forward = createRendererLogForwarder({ logFile: () => f.main, getMetrics: () => [], maxBytes: 300 })
    const source = sender()
    for (let i = 0; i < 80; i++) forward(source, payload({ event: 'escape', sequence: i }))
    expect(readdirSync(f.dir).sort()).toEqual(['gugu-ui-diagnostics.log', 'gugu-ui-diagnostics.log.1', 'gugu-ui-diagnostics.log.2'])
    vi.advanceTimersByTime(60_000)
    forward(source, payload({ event: 'escape', sequence: 81 }))
    expect(JSON.parse(readFileSync(f.file, 'utf8').trim().split('\n').at(-1)!)).toMatchObject({ ipcSuppressed: 20 })
  })

  it('never adds diagnostics to the ordinary feedback tail', () => {
    const f = fresh()
    initLogging({ dir: f.dir, stdout: false })
    writeFileSync(f.main, JSON.stringify({ scope: 'ordinary', msg: 'ordinary line' }) + '\n')
    const forward = createRendererLogForwarder({ getMetrics: () => [] })
    forward(sender(), payload({ event: 'escape', sequence: 12345 }))
    expect(readFileSync(f.file, 'utf8')).toContain('12345')
    expect(readLogTailForFeedback().text).not.toContain('12345')
    expect(readLogTailForFeedback().text).toContain('ordinary line')
  })

  it('keeps JS observations when native metrics fail and never throws on disk or error-outlet failure', () => {
    const f = fresh(), failed = vi.fn(() => { throw new Error('outlet failed') })
    const forward = createRendererLogForwarder({ logFile: () => f.main, getMetrics: () => { throw new Error('native failed') } })
    forward(sender(), payload({ event: 'memory', usedHeapBytes: 12 }))
    expect(JSON.parse(readFileSync(f.file, 'utf8')).nativeMemory).toBeNull()
    const bad = createRendererLogForwarder({ logFile: () => '/dev/null/impossible/main.log', getMetrics: () => [], onError: failed })
    expect(() => bad(sender(), payload({ event: 'escape' }))).not.toThrow()
    expect(() => bad(sender(), payload({ event: 'escape' }))).not.toThrow()
    expect(failed).toHaveBeenCalledOnce()
  })
})
