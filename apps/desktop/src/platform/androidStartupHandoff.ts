import { Capacitor, registerPlugin } from '@capacitor/core'
import { rendererLogger } from '../lib/log'

type Tone = 'light' | 'dark'
interface StartupContext { enabled: boolean; attemptId: string; tone: Tone }
interface StartupChrome {
  startupContext(): Promise<StartupContext>
  startupFrame(options: { attemptId: string; kind: 'motion' | 'content' }): Promise<void>
  startupReactCommit(options: { attemptId: string }): Promise<void>
  startupContentReady(options: { attemptId: string }): Promise<void>
  startupFailed(options: { attemptId: string; reason: string }): Promise<void>
  startupClock(): Promise<{ elapsedMs: number }>
  startupTiming(options: { timing: Record<string, unknown> }): Promise<void>
}
interface MotionHandle { frameReady: Promise<void>; reveal(): void }
export interface AndroidStartupMotionApi {
  defer(): void
  start(options: {
    initialPhase: 'assemble'; hold: boolean; attemptId: string
    palette: { background: string; foregroundRgb: string }
  }): MotionHandle | null
  onContentReady(listener: () => void): () => void
  discard(): void
}

const chrome = registerPlugin<StartupChrome>('GuguShellChrome')
const log = rendererLogger('mobile/startup')
let contextPromise: Promise<StartupContext> | undefined
let bootstrap: Promise<void> | undefined
let rootCommitted = false
let rootCommit: Promise<void> | undefined

export function isAndroidStartupRuntime(): boolean {
  return Capacitor.getPlatform() === 'android'
}

function context(): Promise<StartupContext> {
  contextPromise ??= chrome.startupContext().then(value => {
    if (!value.attemptId || (value.tone !== 'light' && value.tone !== 'dark') || typeof value.enabled !== 'boolean')
      throw new Error('Invalid native startup context')
    return value
  })
  return contextPromise
}

async function runBootstrap(api: AndroidStartupMotionApi): Promise<void> {
  // These must run before the first native await. React may already be committing by its return.
  api.defer()
  let alive = true
  let contentReady = false
  let contentReported = false
  let failed = false
  let failureReason: string | undefined
  let native: StartupContext | undefined
  let unsubscribe = () => {}
  const cleanup = () => {
    unsubscribe()
    window.removeEventListener('error', scriptError, true)
    window.removeEventListener('pagehide', pageHide)
  }
  const pageHide = () => { alive = false; cleanup() }
  const fail = async (reason: string, error: unknown) => {
    if (!alive || failed || contentReady) return
    failed = true
    failureReason = reason
    cleanup()
    api.discard()
    log.error({ reason, error: String(error) }, 'Android startup could not draw its first screen')
    if (native?.enabled) await chrome.startupFailed({ attemptId: native.attemptId, reason }).catch((failure: unknown) => {
      log.error({ error: String(failure) }, 'Android did not receive the startup failure')
    })
  }
  const scriptError = (event: Event) => {
    // Resource failures identify the main document's module script. Ordinary business errors and
    // rejected auth/network requests are not evidence that the main module failed to start.
    const script = event.target as HTMLScriptElement | null
    if (!rootCommitted && script?.tagName === 'SCRIPT' && script.type === 'module')
      void fail('main_module_load_failed', new Error(script.src))
  }
  const reportContent = () => {
    if (!alive || failed || !native?.enabled || contentReported) return
    contentReported = true
    traceStartup('content_ready')
    // Native schedules a real visual-state + draw boundary; this notification does not delay React.
    void chrome.startupContentReady({ attemptId: native.attemptId }).catch((error: unknown) => {
      log.error({ error: String(error) }, 'Android did not receive committed content')
    })
    cleanup()
  }
  window.addEventListener('error', scriptError, true)
  window.addEventListener('pagehide', pageHide, { once: true })
  unsubscribe = api.onContentReady(() => { contentReady = true; reportContent() })
  try {
    native = await context()
    traceStartup('native_context_received')
  } catch (error) {
    // A new Web bundle can be opened in an older native shell. The old path must remain usable.
    api.discard()
    cleanup()
    log.error({ error: String(error) }, 'Native startup handoff is unavailable; using the existing loader')
    return
  }
  if (!alive) return
  if (failed) {
    if (native.enabled && failureReason)
      await chrome.startupFailed({ attemptId: native.attemptId, reason: failureReason }).catch((error: unknown) => {
        log.error({ error: String(error) }, 'Android did not receive the early module failure')
      })
    return
  }
  if (!native.enabled) { api.discard(); cleanup(); return }
  if (contentReady) { reportContent(); return }
  try {
    const handle = api.start({
      initialPhase: 'assemble', hold: true, attemptId: native.attemptId,
      palette: native.tone === 'dark'
        ? { background: '#181818', foregroundRgb: '255,255,255' }
        : { background: '#FFFFFF', foregroundRgb: '24,24,24' },
    })
    if (!handle) { contentReady = true; reportContent(); return }
    await handle.frameReady
    traceStartup('motion_frame_ready')
    if (!alive || failed || contentReady) return
    await chrome.startupFrame({ attemptId: native.attemptId, kind: 'motion' })
    traceStartup('native_remove_acknowledged')
    if (alive && !failed && !contentReady) { handle.reveal(); traceStartup('motion_revealed') }
  } catch (error) { await fail('brand_frame_failed', error) }
}

/** Per-document singleton; an Activity resume never creates another brand instance. */
export function bootstrapAndroidStartup(api: AndroidStartupMotionApi): Promise<void> {
  bootstrap ??= runBootstrap(api)
  return bootstrap
}

let clockSample: Promise<{ offsetMs: number; uncertaintyMs: number }> | undefined
function startupClockSample() {
  clockSample ??= (async () => {
    const before = performance.now()
    const clock = await chrome.startupClock()
    const after = performance.now()
    return { offsetMs: clock.elapsedMs - (before + after) / 2, uncertaintyMs: (after - before) / 2 }
  })()
  return clockSample
}

/** Async diagnostic samples never enter the visual readiness dependency chain. */
function traceStartup(stage: string, at = performance.now()): void {
  void startupClockSample().then(sample => chrome.startupTiming({ timing: {
    stage, elapsedMs: at + sample.offsetMs, clockUncertaintyMs: sample.uncertaintyMs,
  } })).catch((error: unknown) => {
    log.error({ stage, error: String(error) }, 'Startup timing was not recorded')
  })
}

function observeStartupPaint(): void {
  if (typeof PerformanceObserver !== 'undefined') try {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) traceStartup(entry.name, entry.startTime)
      if (list.getEntries().some(entry => entry.name === 'first-contentful-paint')) observer.disconnect()
    })
    observer.observe({ type: 'paint', buffered: true })
    return
  } catch {
    // Older WebViews may lack buffered paint observations. Native draw still owns handoff.
  }
  for (const entry of performance.getEntriesByType('paint')) traceStartup(entry.name, entry.startTime)
}

/** Only the first React commit. Brand readiness and real-content readiness are separate signals. */
export function reportAndroidStartupFrame(): Promise<void> {
  rootCommitted = true
  rootCommit ??= (async () => {
    traceStartup('react_commit')
    observeStartupPaint()
    const native = await context()
    if (native.enabled) await chrome.startupReactCommit({ attemptId: native.attemptId })
  })()
  return rootCommit
}
