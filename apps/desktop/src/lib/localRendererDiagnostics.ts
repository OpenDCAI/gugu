import { diagnosticStack, LOCAL_DIAGNOSTICS_SCOPE, MEMORY_SAMPLE_INTERVAL, sanitizeDiagnosticFields, type DiagnosticFields } from '../../shared/local-renderer-diagnostics'
import { hasRendererLogBridge, rendererLogger } from './log'

type Layer = { id: number; kind: string; open: boolean; connected: boolean; inert: boolean }
type EscapeTrace = { owners: string[]; decisions: string[]; bubble: boolean }
type ObserverEntry = PerformanceEntry & { attribution?: Array<{ containerSrc?: string; containerType?: string }> }
const OVERLAYS = '[role="dialog"],[role="alertdialog"],[role="menu"],[data-slot="popover-content"],[data-slot="popover-popup"],[data-slot="sheet-popup"]'
let current: ReturnType<typeof createLocalRendererDiagnostics> | null = null

/** Only metadata is read. No values, textContent, titles, URL queries, or input other than Escape. */
export function createLocalRendererDiagnostics(win: Window & typeof globalThis, output: (fields: DiagnosticFields) => void) {
  const pageId = win.crypto.randomUUID()
  let stopped = false, layerId = 0, sequence = 0, windowAt = Date.now(), emitted = 0, tasks = 0, suppressed = 0, longTasksSuppressed = 0
  const layers = new Map<Element, Layer>()
  const ids = new WeakMap<Element, number>()
  const escapes = new WeakMap<Event, EscapeTrace>()
  const roots = new WeakSet<Node>()
  const rootRefs: WeakRef<Node>[] = []
  let rescan: ReturnType<typeof setTimeout> | null = null
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const emit = (fields: DiagnosticFields) => {
    if (stopped) return
    try {
      const now = Date.now()
      if (now - windowAt >= 60_000) {
        if (suppressed || longTasksSuppressed) output({ event: 'suppressed', pageId, at: now, suppressed, longTasksSuppressed })
        windowAt = now; emitted = 0; tasks = 0; suppressed = 0; longTasksSuppressed = 0
      }
      if (fields.event === 'long-task' && tasks++ >= 10) { longTasksSuppressed++; return }
      if (fields.event !== 'memory' && emitted++ >= 50) { suppressed++; return }
      const safe = sanitizeDiagnosticFields({ ...fields, pageId, at: fields.at ?? now })
      if (safe) output(safe)
    } catch { /* Diagnostic failures must not change rendering or event propagation. */ }
  }
  const snapshot = () => [...layers.values()].slice(-16).map(layer => ({ ...layer }))
  const isInert = (element: Element) => {
    let current: Element | null = element
    while (current) {
      if (current.hasAttribute('inert')) return true
      const root = current.getRootNode()
      current = current.parentElement ?? (root instanceof win.ShadowRoot ? root.host : null)
    }
    return false
  }
  const inspect = (element: Element) => {
    const old = layers.get(element)
    const connected = element.isConnected
    const open = connected && !element.hasAttribute('data-closed') && !element.hasAttribute('data-ending-style')
    if (!old && (!connected || layers.size >= 32)) return
    const kind = element.getAttribute('role') === 'alertdialog' ? 'alertdialog'
      : element.getAttribute('role') === 'menu' ? 'menu' : (element.getAttribute('data-slot') ?? '').startsWith('popover') ? 'popover'
        : element.getAttribute('data-slot') === 'sheet-popup' ? 'sheet' : 'dialog'
    if (!ids.has(element)) ids.set(element, ++layerId)
    const layer = { id: ids.get(element)!, kind, open, connected, inert: isInert(element) }
    if (connected) layers.set(element, layer)
    else layers.delete(element)
    if (!old || old.open !== open || old.connected !== connected) emit({ event: open ? 'overlay-open' : 'overlay-close', layerId: layer.id, layers: snapshot() })
  }
  const scan = (element: Element) => {
    if (element.matches(OVERLAYS)) inspect(element)
    for (const layer of [...element.querySelectorAll(OVERLAYS)].slice(0, 32)) inspect(layer)
  }
  const mutation = new win.MutationObserver(records => {
    for (const element of layers.keys()) inspect(element)
    // Added subtrees only, with a bounded batch. Ordinary message updates never scan the whole page.
    let visited = 0
    for (const record of records) {
      if (++visited > 128) break
      if (record.type === 'attributes' && record.target instanceof win.Element && record.target.matches(OVERLAYS)) inspect(record.target)
      for (const added of record.addedNodes) {
        if (++visited > 128) break
        if (added instanceof win.Element) scan(added)
      }
    }
    if (visited > 128 && rescan === null) {
      rescan = setTimeout(() => {
        rescan = null
        for (const ref of rootRefs) {
          const root = ref.deref() as ParentNode | undefined
          if (root) for (const element of [...root.querySelectorAll(OVERLAYS)].slice(0, 32)) inspect(element)
        }
      }, 0)
    }
  })
  const observeRoot = (root: Node) => {
    if (roots.has(root)) return
    for (let i = rootRefs.length - 1; i >= 0; i--) if (!rootRefs[i].deref()) rootRefs.splice(i, 1)
    if (rootRefs.length >= 32) { suppressed++; return }
    mutation.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-open', 'data-closed', 'data-ending-style', 'inert'] })
    roots.add(root)
    rootRefs.push(new WeakRef(root))
    if (root instanceof win.Element) scan(root)
    else if (root instanceof win.Document || root instanceof win.ShadowRoot) {
      for (const element of [...root.querySelectorAll(OVERLAYS)].slice(0, 32)) inspect(element)
    }
  }
  observeRoot(win.document)
  const capture = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    if (timers.size >= 32) { suppressed++; return }
    const received = win.performance.now(), before = snapshot(), id = ++sequence
    const trace: EscapeTrace = { owners: [], decisions: [], bubble: false }
    escapes.set(event, trace)
    const eventAt = event.timeStamp > 1e12 ? event.timeStamp : win.performance.timeOrigin + event.timeStamp
    const timer = setTimeout(() => {
      timers.delete(timer)
      for (const element of layers.keys()) inspect(element)
      let focused = win.document.activeElement
      while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement
      emit({ event: 'escape', sequence: id, eventAt, captureDelayMs: Math.max(0, received + win.performance.timeOrigin - eventAt),
        observedAfterMs: win.performance.now() - received, trusted: event.isTrusted, composing: event.isComposing,
        defaultPrevented: event.defaultPrevented, bubbleReached: trace.bubble,
        handledBy: trace.owners.length ? trace.owners : ['unknown'], decisions: trace.decisions, before, after: snapshot(),
        focusTag: ['INPUT', 'TEXTAREA', 'BUTTON', 'DIV', 'BODY', 'IFRAME'].includes(focused?.tagName ?? '') ? focused!.tagName : 'OTHER',
        inertElements: win.document.querySelectorAll('[inert]').length })
    }, 0)
    timers.add(timer)
  }
  const bubble = (event: KeyboardEvent) => { const trace = escapes.get(event); if (trace) trace.bubble = true }
  win.addEventListener('keydown', capture, true)
  win.addEventListener('keydown', bubble)
  let performanceObserver: PerformanceObserver | null = null
  let longTaskSupported = false
  if (win.PerformanceObserver?.supportedEntryTypes?.includes('longtask')) {
    try { performanceObserver = new win.PerformanceObserver(list => {
      for (const raw of list.getEntries()) {
        const entry = raw as ObserverEntry
        if (entry.duration <= 200) continue
        emit({ event: 'long-task', eventAt: win.performance.timeOrigin + entry.startTime, durationMs: entry.duration, layers: snapshot(),
          attribution: entry.attribution?.length ? entry.attribution.slice(0, 4).map(item => ({ source: item.containerSrc, container: item.containerType })) : [{ source: 'unknown', container: 'window' }] })
      }
    })
    performanceObserver.observe({ type: 'longtask' })
    longTaskSupported = true
    } catch { performanceObserver?.disconnect(); performanceObserver = null }
  }
  const memory = () => {
    const value = (win.performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory
    const liveRoots = rootRefs.flatMap(ref => { const root = ref.deref(); return root ? [root] : [] })
    const domElements = liveRoots.reduce((sum, root) => sum + (root as ParentNode).querySelectorAll('*').length, 0)
    emit({ event: 'memory', usedHeapBytes: value?.usedJSHeapSize, totalHeapBytes: value?.totalJSHeapSize,
      heapLimitBytes: value?.jsHeapSizeLimit, domElements, observedRoots: liveRoots.length,
      detachedRoots: liveRoots.filter(root => !root.isConnected).length })
  }
  emit({ event: 'start', longTaskSupported })
  memory()
  const interval = setInterval(memory, MEMORY_SAMPLE_INTERVAL)
  return {
    observeRoot,
    request(details: unknown, owner: string, nextOpen: boolean, decision = 'open-change-request') {
      const record = details && typeof details === 'object' ? details as { event?: Event | { nativeEvent?: Event }; isCanceled?: boolean } : {}
      const event = record.event instanceof win.Event ? record.event : record.event?.nativeEvent
      const trace = event ? escapes.get(event) : null
      if (trace) { trace.owners.push(owner); trace.decisions.push(decision) }
      emit({ event: 'overlay-request', owner, nextOpen, cancelled: record.isCanceled === true,
        callers: emitted < 50 ? diagnosticStack(new Error().stack) : [], layers: snapshot() })
    },
    stop() {
      if (stopped) return
      stopped = true
      mutation.disconnect(); performanceObserver?.disconnect(); clearInterval(interval)
      if (rescan !== null) clearTimeout(rescan)
      for (const timer of timers) clearTimeout(timer)
      timers.clear(); layers.clear()
      win.removeEventListener('keydown', capture, true); win.removeEventListener('keydown', bubble)
    },
  }
}

export function noteOverlayRequest(details: unknown, owner: string, nextOpen: boolean, decision?: string): void {
  try { current?.request(details, owner, nextOpen, decision) } catch { /* Never interfere with a UI callback. */ }
}

export function observeLocalDiagnosticRoot(root: Node): void {
  try { current?.observeRoot(root) } catch { /* A detached root cannot interfere with rendering. */ }
}

export function installLocalRendererDiagnostics(): void {
  if (current || typeof window === 'undefined' || !window.desktopWindow || !hasRendererLogBridge()) return
  try {
    const log = rendererLogger(LOCAL_DIAGNOSTICS_SCOPE)
    current = createLocalRendererDiagnostics(window, fields => log.info(fields, 'Local renderer diagnostic'))
    window.addEventListener('pagehide', () => { current?.stop(); current = null }, { once: true })
  } catch { /* Unsupported browser diagnostics must not prevent startup. */ }
}

if (import.meta.hot) import.meta.hot.dispose(() => { current?.stop(); current = null })
