// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalRendererDiagnostics } from '../../../../apps/desktop/src/lib/localRendererDiagnostics'
import { MEMORY_SAMPLE_INTERVAL, type DiagnosticFields } from '../../../../apps/desktop/shared/local-renderer-diagnostics'

let recorder: ReturnType<typeof createLocalRendererDiagnostics> | null = null
afterEach(() => { recorder?.stop(); recorder = null; document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals() })
const microtask = () => Promise.resolve()

describe('local renderer observations', () => {
  it('records only tasks above 200ms, with bounded source attribution and a visible suppression count', () => {
    vi.useFakeTimers()
    let deliver: ((list: { getEntries(): PerformanceEntry[] }) => void) | undefined
    const disconnect = vi.fn()
    vi.stubGlobal('PerformanceObserver', class {
      static supportedEntryTypes = ['longtask']
      constructor(callback: typeof deliver) { deliver = callback }
      observe() {}
      disconnect = disconnect
    })
    const rows: DiagnosticFields[] = []
    recorder = createLocalRendererDiagnostics(window, row => rows.push(row))
    const entries = [199, 200, ...Array(14).fill(201)].map(duration => ({ duration, startTime: 15,
      attribution: [{ containerSrc: 'https://private.example/query?secret=yes', containerType: 'iframe', containerName: 'private message' }] }))
    deliver!({ getEntries: () => entries as unknown as PerformanceEntry[] })
    expect(rows.filter(row => row.event === 'long-task')).toHaveLength(10)
    expect(rows.find(row => row.event === 'long-task')).toMatchObject({ durationMs: 201, attribution: [{ source: 'unknown', container: 'iframe' }] })
    expect(JSON.stringify(rows)).not.toContain('private')
    vi.advanceTimersByTime(60_001)
    deliver!({ getEntries: () => [] })
    vi.advanceTimersByTime(MEMORY_SAMPLE_INTERVAL)
    expect(rows.find(row => row.event === 'suppressed')).toMatchObject({ longTasksSuppressed: 4 })
    recorder.stop()
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('samples memory every five minutes and removes timers/listeners on disposal', () => {
    vi.useFakeTimers()
    const rows: DiagnosticFields[] = []
    recorder = createLocalRendererDiagnostics(window, row => rows.push(row))
    expect(rows.filter(row => row.event === 'memory')).toHaveLength(1)
    vi.advanceTimersByTime(MEMORY_SAMPLE_INTERVAL - 1)
    expect(rows.filter(row => row.event === 'memory')).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(rows.filter(row => row.event === 'memory')).toHaveLength(2)
    recorder.stop()
    const count = rows.length
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    vi.advanceTimersByTime(MEMORY_SAMPLE_INTERVAL)
    expect(rows).toHaveLength(count)
  })

  it('keeps handled Escape attribution and actual closed layers without altering the event', async () => {
    vi.useFakeTimers()
    const rows: DiagnosticFields[] = []
    recorder = createLocalRendererDiagnostics(window, row => rows.push(row))
    const popup = document.createElement('div'); popup.setAttribute('role', 'dialog'); popup.textContent = 'private message'
    document.body.append(popup); await microtask()
    popup.addEventListener('keydown', event => {
      event.preventDefault(); event.stopPropagation()
      recorder!.request({ event }, 'app-dialog', false)
      popup.remove()
    })
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    expect(popup.dispatchEvent(event)).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    const result = rows.find(row => row.event === 'escape')!
    expect(result).toMatchObject({ handledBy: ['app-dialog'], defaultPrevented: true, bubbleReached: false, after: [] })
    expect(result.before).toMatchObject([{ kind: 'dialog', open: true }])
    expect(rows.filter(row => row.event === 'overlay-close')).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain('private message')
  })

  it('reports a guard decision separately from closure and labels unrelated handlers unknown', async () => {
    vi.useFakeTimers()
    const rows: DiagnosticFields[] = []
    recorder = createLocalRendererDiagnostics(window, row => rows.push(row))
    const popup = document.createElement('div'); popup.setAttribute('role', 'dialog'); document.body.append(popup); await microtask()
    popup.addEventListener('keydown', event => recorder!.request({ event }, 'session-modal', false, 'blocked-close-guard'), { once: true })
    popup.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await vi.advanceTimersByTimeAsync(0)
    expect(rows.find(row => row.event === 'escape')).toMatchObject({ decisions: ['blocked-close-guard'], after: [{ open: true }] })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(rows.filter(row => row.event === 'escape')).toHaveLength(2)
    expect(rows.filter(row => row.event === 'escape')[1].handledBy).toEqual(['unknown'])
  })

  it('observes embedded shadow roots and recovers rare layers after a large ordinary DOM batch', async () => {
    vi.useFakeTimers()
    const rows: DiagnosticFields[] = []
    recorder = createLocalRendererDiagnostics(window, row => rows.push(row))
    const host = document.createElement('div'); document.body.append(host); const root = host.attachShadow({ mode: 'open' })
    recorder.observeRoot(root)
    for (let i = 0; i < 200; i++) root.append(document.createElement('span'))
    const popup = document.createElement('div'); popup.setAttribute('role', 'alertdialog'); root.append(popup)
    await microtask(); await vi.advanceTimersByTimeAsync(0)
    expect(rows.some(row => row.event === 'overlay-open' && (row.layers as Array<{ kind: string }>).some(layer => layer.kind === 'alertdialog'))).toBe(true)
  })

  it('can retry a root refused at the cap after another root has been collected', async () => {
    const refs: Array<{ value?: object }> = []
    vi.stubGlobal('WeakRef', class {
      value?: object
      constructor(value: object) { this.value = value; refs.push(this) }
      deref() { return this.value }
    })
    const rows: DiagnosticFields[] = []
    recorder = createLocalRendererDiagnostics(window, row => rows.push(row))
    for (let i = 0; i < 31; i++) recorder.observeRoot(document.createElement('div').attachShadow({ mode: 'open' }))
    const host = document.createElement('div'); document.body.append(host)
    const root = host.attachShadow({ mode: 'open' })
    recorder.observeRoot(root)
    refs[1].value = undefined // Deterministic collection boundary, no forced GC.
    recorder.observeRoot(root)
    const popup = document.createElement('div'); popup.setAttribute('role', 'dialog'); root.append(popup)
    await microtask()
    expect(rows.some(row => row.event === 'overlay-open')).toBe(true)
  })
})
