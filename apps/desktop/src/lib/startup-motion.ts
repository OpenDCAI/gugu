import { isAnimationWindowVisible, subscribeAnimationWindowVisibility } from '@gugu/session-shared/animation-visibility'
import motionDocument from './startup-motion.html?raw'

export type StartupMotionOptions = {
  initialPhase?: 'assemble' | 'settled'
  hold?: boolean
  attemptId?: string
  palette?: { background: string; foregroundRgb: string }
}
export type StartupMotionHandle = {
  frame: HTMLIFrameElement
  frameReady: Promise<void>
  reveal(): void
}
type StartupState = {
  host: HTMLElement
  frame: HTMLIFrameElement | null
  owners: Set<symbol>
  committed: boolean
  deferred: boolean
  discarded: boolean
  contentReady: boolean
  ready: boolean
  revealed: boolean
  held: boolean
  attemptId: string
  readyPromise: Promise<void>
  resolveReady(): void
  rejectReady(error: Error): void
  onContent: Set<() => void>
  onChange: Set<() => void>
  cleanup: Array<() => void>
  brand: HTMLElement | null
}
type StartupDocument = Document & { startupContinuity?: StartupState }

function current(): StartupState | null {
  const doc = document as StartupDocument
  const host = document.querySelector<HTMLElement>('[data-gugu-boot]')
  if (!host) return doc.startupContinuity ?? null
  if (doc.startupContinuity?.host === host) return doc.startupContinuity
  let resolveReady!: () => void, rejectReady!: (error: Error) => void
  const readyPromise = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  // The public promise retains its rejection for an Android handoff consumer. A
  // fast content commit may cancel it before that consumer has attached.
  void readyPromise.catch(() => {})
  return doc.startupContinuity = {
    host, frame: null, owners: new Set(), committed: false, deferred: false,
    discarded: false, contentReady: false, ready: false, revealed: false, held: false, attemptId: '',
    readyPromise, resolveReady, rejectReady, onContent: new Set(), onChange: new Set(),
    cleanup: [], brand: null,
  }
}
function changed(state: StartupState): void { for (const listener of state.onChange) listener() }
function available(state: StartupState | null): state is StartupState {
  return Boolean(state && state.host.isConnected && !state.discarded && !state.contentReady)
}
export function hasStartupMotion(): boolean { return available(current()) }
export function hasStartupVisual(): boolean {
  const state = current()
  return Boolean(state && state.host.isConnected && !state.discarded)
}
export function subscribeStartupMotion(listener: () => void): () => void {
  const state = current()
  if (!state) return () => {}
  state.onChange.add(listener)
  return () => { state.onChange.delete(listener) }
}

/** Reserve ownership before Android's first await; React cannot start assemble early. */
export function deferStartupMotion(): void {
  // Android owns the explicit request. A desktop-only build has no phone host;
  // later Activity resumes/late callbacks cannot recreate a finished document.
  const doc = document as StartupDocument
  if (!doc.startupContinuity && !document.querySelector('[data-gugu-boot]')) {
    const host = document.createElement('div')
    host.setAttribute('data-gugu-boot', '')
    host.setAttribute('aria-hidden', 'true')
    document.body.prepend(host)
  }
  const state = current()
  if (!available(state) || state.frame) return
  state.deferred = true
  state.host.querySelector(':scope > svg')?.setAttribute('hidden', '')
}
function paletteFor(element: HTMLElement): { background: string; foregroundRgb: string } {
  const colors = getComputedStyle(element)
  const rgb = colors.color.match(/[\d.]+/g)
  if (!rgb || rgb.length < 3) throw new Error('Startup foreground is unavailable')
  return { background: colors.backgroundColor, foregroundRgb: rgb.slice(0, 3).join(',') }
}

/** One browsing context, beginning in HTML and retained across React commits. */
export function startStartupMotion(options: StartupMotionOptions = {}): StartupMotionHandle | null {
  const state = current()
  if (!available(state)) return null
  if (!state.frame) {
    const palette = options.palette ?? paletteFor(state.host)
    state.deferred = false
    state.held = Boolean(options.hold)
    state.attemptId = options.attemptId ?? crypto.randomUUID()
    const frame = document.createElement('iframe')
    state.frame = frame
    frame.title = 'gugu'; frame.tabIndex = -1
    frame.name = 'gugu-startup-' + state.attemptId
    frame.setAttribute('sandbox', 'allow-scripts')
    // Keep the source's 640px viewport (592px wordmark) intact. Shrinking that
    // viewport before applying .6 would scale a phone's wordmark twice.
    const sizeFrame = () => {
      if (!state.contentReady || !state.brand)
        frame.style.transform = `scale(${Math.min(.6, Math.max(0, (window.innerWidth - 48) / 592))})`
    }
    sizeFrame()
    window.addEventListener('resize', sizeFrame)
    state.cleanup.push(() => window.removeEventListener('resize', sizeFrame))
    frame.srcdoc = motionDocument
      .replaceAll('__MOTION_RGB__', palette.foregroundRgb)
      .replaceAll('__MOTION_BG__', palette.background)
      .replaceAll('__STARTUP_PHASE__', options.initialPhase ?? 'assemble')
      .replaceAll('__STARTUP_HOLD__', options.hold ? 'true' : 'false')
      .replaceAll('__STARTUP_ATTEMPT__', state.attemptId)
    state.host.style.backgroundColor = palette.background
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.data?.attemptId !== state.attemptId || state.discarded || !state.host.isConnected) return
      if (event.data.type === 'gugu-startup-error') {
        const error = new Error('Startup motion: ' + String(event.data.message))
        state.host.dataset.startupFailure = error.message
        state.rejectReady(error)
        discardStartupMotion()
        return
      }
      if (event.data.type !== 'gugu-startup-painted' || state.ready) return
      state.ready = true
      frame.style.opacity = '1'
      state.host.querySelector(':scope > svg')?.remove()
      state.resolveReady()
      finishHeldBrand(state)
    }
    window.addEventListener('message', onMessage)
    state.cleanup.push(() => window.removeEventListener('message', onMessage))
    const tellWindow = () => frame.contentWindow?.postMessage({ type: 'gugu-startup-window', attemptId: state.attemptId, visible: isAnimationWindowVisible() }, '*')
    state.cleanup.push(subscribeAnimationWindowVisibility(tellWindow))
    frame.addEventListener('load', tellWindow)
    state.host.append(frame)
  }
  return { frame: state.frame, frameReady: state.readyPromise, reveal: () => {
    if (!state.ready || state.revealed || state.discarded || !state.host.isConnected) return
    state.revealed = true
    state.held = false
    state.frame!.contentWindow?.postMessage({ type: 'gugu-startup-reveal', attemptId: state.attemptId }, '*')
  } }
}
function releaseFrame(state: StartupState): void {
  for (const cleanup of state.cleanup.splice(0)) cleanup()
  if (!state.ready) state.rejectReady(new DOMException('Startup replaced by content', 'AbortError'))
  state.host.remove()
  state.frame = null
  changed(state)
}
function finishIfUnused(state: StartupState): void {
  // StrictMode's cleanup/reacquire completes in the same commit. No display timer.
  queueMicrotask(() => {
    if (!available(state) || !state.committed || state.owners.size) return
    state.contentReady = true
    try {
      for (const listener of [...state.onContent]) listener()
    } finally {
      state.onContent.clear()
      if (state.brand?.isConnected && state.brand.getBoundingClientRect().width > 0) positionInBrand(state)
      else releaseFrame(state)
      changed(state)
    }
  })
}
export function retainStartupMotion(): () => void {
  const state = current()
  if (!available(state)) return () => {}
  if (!state.deferred) startStartupMotion()
  const owner = Symbol('startup-loader')
  state.owners.add(owner)
  return () => { state.owners.delete(owner); finishIfUnused(state) }
}
export function commitStartupContent(): void {
  const state = current()
  if (available(state)) { state.committed = true; finishIfUnused(state) }
}
export function subscribeStartupContentReady(listener: () => void): () => void {
  const state = current()
  if (!state) return () => {}
  if (state.contentReady) { listener(); return () => {} }
  state.onContent.add(listener)
  return () => { state.onContent.delete(listener) }
}
export function discardStartupMotion(): void {
  const state = current()
  if (!state || state.discarded) return
  state.discarded = true
  releaseFrame(state) // OFF/error is not a content-ready signal.
}

function positionInBrand(state: StartupState): void {
  if (!state.brand || !state.contentReady || !state.host.isConnected) return
  const rect = state.brand.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) { state.host.style.visibility = 'hidden'; return }
  const palette = paletteFor(state.brand)
  Object.assign(state.host.style, { visibility: 'visible', inset: 'auto', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, zIndex: '1', backgroundColor: palette.background, color: `rgb(${palette.foregroundRgb})` })
  // Startup uses the small centered wordmark. Once real content owns the frame,
  // preserve the approved full-column login artwork without a new document.
  if (state.frame) Object.assign(state.frame.style, { width: `${rect.width}px`, height: `${rect.height}px`, transform: 'none' })
  state.frame?.contentWindow?.postMessage({ type: 'gugu-startup-palette', attemptId: state.attemptId, ...palette }, '*')
  finishHeldBrand(state)
}
function finishHeldBrand(state: StartupState): void {
  if (!state.contentReady || !state.brand?.isConnected || !state.ready || !state.held) return
  // Content already won the native handoff. The retained frame is now ordinary
  // login artwork: do not replay a loading entrance or wait for a motion ACK.
  state.held = false
  state.revealed = true
  state.frame?.contentWindow?.postMessage({ type: 'gugu-startup-content', attemptId: state.attemptId }, '*')
}
/** Keep the original frame in place in the DOM; moving an iframe would reload it. */
export function claimStartupBrand(element: HTMLElement): (() => void) | null {
  const state = current()
  if (!available(state) || element.getBoundingClientRect().width <= 0) return null
  state.brand = element
  const update = () => positionInBrand(state)
  let resizeFrame = 0
  const resize = new ResizeObserver(() => {
    if (!resizeFrame) resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; update() })
  })
  resize.observe(element)
  const theme = new MutationObserver(update)
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  window.addEventListener('scroll', update, true)
  const cleanup = () => { resize.disconnect(); cancelAnimationFrame(resizeFrame); theme.disconnect(); window.removeEventListener('scroll', update, true) }
  state.cleanup.push(cleanup)
  return () => {
    cleanup()
    if (state.brand === element) { state.brand = null; if (state.contentReady) releaseFrame(state) }
  }
}
