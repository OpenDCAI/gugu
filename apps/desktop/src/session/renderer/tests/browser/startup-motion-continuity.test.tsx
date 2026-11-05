import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { cdp, page, userEvent } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'
import indexDocument from '../../../../../index.html?raw'
import poster from '../../../../lib/startup-motion-poster.svg?raw'
import { startStartupMotion, deferStartupMotion, discardStartupMotion, retainStartupMotion, commitStartupContent } from '../../../../lib/startup-motion'
import { FullScreenLoader } from '../../../../components/FullScreenLoader'
import { StartupMotionBoundary } from '../../../../components/StartupMotionBoundary'
import { i18n } from '@/i18n'
import '@/i18n/registerMainCatalog'
import '@/styles/tokens.css'

vi.mock('@/lib/auth', () => ({ authService: {} }))
vi.mock('@/lib/sessionCoordinator', () => ({ sessionCoordinator: {} }))
vi.mock('@gugu/core/cloud/config', () => ({ getSupabaseUrl: () => 'https://auth.fixture.invalid', getSupabaseAnonKey: () => 'public-fixture-key' }))
vi.mock('@/lib/googleLogin', () => ({ googleLogin: { available: true, subscribe: () => () => {}, getSnapshot: () => idle } }))
const idle = { phase: 'idle', busy: false }
const { LoginPage } = await import('@/pages/LoginPage')
let root: Root | undefined, rootHost: HTMLElement | undefined, style: HTMLStyleElement | undefined
type FrameTree = { frame: { id: string; name?: string }; childFrames?: FrameTree[] }
type CanvasSnapshot = { timeOrigin: number; phase: string; canvasCount: number; scriptCount: number; left: number; top: number; width: number; height: number; hash: number; pixels: number; fontStatus: string }
const session = () => cdp() as unknown as { send<T = unknown>(method: string, params?: object): Promise<T> }
async function media(reduce: boolean) {
  await session().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }] })
}
function mountHtml(theme: string) {
  document.documentElement.dataset.theme = theme
  style = document.createElement('style')
  style.textContent = indexDocument.match(/<style>([\s\S]*?)<\/style>/)![1]!
  document.head.append(style)
  const boot = document.createElement('div')
  boot.setAttribute('data-gugu-boot', '')
  boot.setAttribute('aria-hidden', 'true')
  boot.innerHTML = poster
  document.body.append(boot)
  rootHost = document.createElement('div'); document.body.append(rootHost)
  root = createRoot(rootHost)
  return boot
}
async function world(frame: HTMLIFrameElement) {
  const response = await session().send<{ frameTree: FrameTree }>('Page.getFrameTree')
  const find = (node: FrameTree): string | null => node.frame.name === frame.name ? node.frame.id : (node.childFrames ?? []).map(find).find(Boolean) ?? null
  const frameId = find(response.frameTree)
  expect(frameId, 'the actual sandboxed animation browsing context is present').not.toBeNull()
  const { executionContextId } = await session().send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId, worldName: 'startup-readonly-proof' })
  return executionContextId
}
async function snapshot(frame: HTMLIFrameElement) {
  const executionContextId = await world(frame)
  const result = await session().send<{ exceptionDetails?: unknown; result: { value: CanvasSnapshot } }>('Runtime.evaluate', { contextId: executionContextId, returnByValue: true, expression: `(() => {
    const canvas = document.querySelector('canvas'), r = canvas.getBoundingClientRect(), data = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    let hash=2166136261, pixels=0;
    for(let i=0;i<data.length;i++){hash=Math.imul(hash^data[i],16777619);if(i%4===3&&data[i])pixels++}
    return {timeOrigin:performance.timeOrigin,phase:canvas.dataset.phase,canvasCount:document.querySelectorAll('canvas').length,scriptCount:document.querySelectorAll('script').length,left:r.left,top:r.top,width:r.width,height:r.height,hash:hash>>>0,pixels,fontStatus:document.fonts.status};
  })()` })
  expect(result.exceptionDetails).toBeUndefined()
  return result.result.value
}
async function settledFrame(frame: HTMLIFrameElement) {
  const contextId = await world(frame)
  const result = await session().send<{ exceptionDetails?: unknown }>('Runtime.evaluate', { contextId, awaitPromise: true, expression: `new Promise(resolve => {
    const canvas = document.querySelector('canvas');
    if (canvas.dataset.phase === 'settled') { resolve(true); return; }
    const observer = new MutationObserver(() => { if (canvas.dataset.phase === 'settled') { observer.disconnect(); resolve(true); } });
    observer.observe(canvas, { attributes: true, attributeFilter: ['data-phase'] });
  })` });
  expect(result.exceptionDetails).toBeUndefined()
}
beforeAll(async () => { await i18n.changeLanguage('zh-CN') })
afterEach(async () => {
  root?.unmount(); root = undefined
  rootHost?.remove(); rootHost = undefined
  discardStartupMotion(); style?.remove(); style = undefined
  document.documentElement.removeAttribute('data-theme')
  vi.unstubAllGlobals(); await media(false)
})

for (const theme of ['light', 'dark']) it(`retains one real iframe from HTML through loading, provider pending, login and theme changes: ${theme}`, async () => {
  await page.viewport(1280, 840); await media(false)
  const boot = mountHtml(theme)
  let release!: (response: Response) => void
  const pending = new Promise<Response>(resolve => { release = resolve })
  vi.stubGlobal('fetch', () => pending)
  const handle = startStartupMotion()!, frame = handle.frame, context = frame.contentWindow
  root!.render(<StartupMotionBoundary><FullScreenLoader /></StartupMotionBoundary>)
  await handle.frameReady
  const first = await snapshot(frame)
  expect(first.canvasCount).toBe(1); expect(first.scriptCount).toBe(1); expect(first.pixels).toBeGreaterThan(0)
  expect(first.fontStatus).toBe('loaded')
  expect(first.width * frame.getBoundingClientRect().width / 640).toBeCloseTo(355.2)
  expect(first.height * .6).toBe(96)
  expect(rootHost!.querySelector('[data-testid=loading-indicator]')).toBeNull()

  root!.render(<StartupMotionBoundary><LoginPage /></StartupMotionBoundary>)
  await until('provider placeholder has committed', () => !!rootHost!.querySelector('.gugu-auth-placeholder'))
  expect(document.querySelector('[data-gugu-boot] iframe')).toBe(frame)
  expect(frame.contentWindow).toBe(context)
  expect((await snapshot(frame)).timeOrigin).toBe(first.timeOrigin)
  release(Response.json({ external: { google: true } }))
  await until('real email control is committed', () => !!rootHost!.querySelector('input[type=email]'))
  await until('the same frame has moved visually into the brand slot', () => document.querySelector<HTMLElement>('[data-gugu-boot]')?.style.zIndex === '1')
  expect(document.querySelectorAll('iframe[title=gugu]')).toHaveLength(1)
  expect(frame.contentWindow).toBe(context)
  const brandRect = rootHost!.querySelector('.gugu-auth-motion')!.getBoundingClientRect()
  expect(frame.getBoundingClientRect().width).toBeCloseTo(brandRect.width)
  expect((await snapshot(frame)).width).toBeCloseTo(brandRect.width - 48)
  for (const next of [theme === 'light' ? 'dark' : 'light', theme]) {
    document.documentElement.dataset.theme = next
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    expect((await snapshot(frame)).timeOrigin).toBe(first.timeOrigin)
  }
  await userEvent.fill(rootHost!.querySelector<HTMLInputElement>('input[type=email]')!, 'ui-only@example.invalid')
  expect(rootHost!.querySelector<HTMLInputElement>('input[type=email]')!.value).toBe('ui-only@example.invalid')
  for (const width of [719, 800]) {
    await page.viewport(width, 840)
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    expect(frame.isConnected, boot.dataset.startupFailure ?? 'the original startup frame remains connected').toBe(true)
    expect(frame.contentWindow === context).toBe(true)
    expect((await snapshot(frame)).timeOrigin).toBe(first.timeOrigin)
  }
})

it('holds the actual entrance clock until native reveal, then settles and runs the wave once', async () => {
  await page.viewport(1280, 840); await media(false); mountHtml('light')
  deferStartupMotion()
  const release = retainStartupMotion()
  const handle = startStartupMotion({initialPhase:'assemble',hold:true,attemptId:'held-browser-proof'})!
  await handle.frameReady
  const held = await snapshot(handle.frame)
  const holdStart = performance.now()
  await until('the observed held interval exceeds the 1.2s entrance', () => performance.now() - holdStart > 1400)
  expect((await snapshot(handle.frame)).hash).toBe(held.hash)
  expect((await snapshot(handle.frame)).phase).toBe('entering')
  handle.reveal()
  await settledFrame(handle.frame)
  const settled = await snapshot(handle.frame)
  handle.reveal()
  const sampleStart = performance.now()
  await until('the real animation observation interval has elapsed', () => performance.now() - sampleStart > 650)
  const wave = await snapshot(handle.frame)
  expect(wave.timeOrigin).toBe(held.timeOrigin)
  expect(wave.phase).toBe('settled')
  expect(wave.hash).not.toBe(settled.hash)
  release()
})

it('uses the actual reduced-motion media feature for a static wordmark', async () => {
  await page.viewport(1280, 840); await media(true); mountHtml('dark')
  const handle = startStartupMotion({hold:true,attemptId:'reduced-browser-proof'})!
  await handle.frameReady; handle.reveal()
  const first = await snapshot(handle.frame)
  expect(first.phase).toBe('settled')
  const sampleStart = performance.now()
  await until('the real animation observation interval has elapsed', () => performance.now() - sampleStart > 650)
  expect((await snapshot(handle.frame)).hash).toBe(first.hash)
})

it('waits for real nonzero canvas geometry rather than failing or starting a hidden clock', async () => {
  await page.viewport(1280, 840); await media(false)
  const boot = mountHtml('light'); boot.style.display = 'none'
  const handle = startStartupMotion({hold:true,attemptId:'geometry-browser-proof'})!
  let ready = false; void handle.frameReady.then(() => { ready = true })
  const hiddenStart = performance.now()
  await until('the hidden layout observation interval has elapsed', () => performance.now() - hiddenStart > 200)
  expect(ready).toBe(false)
  boot.style.display = 'grid'
  await handle.frameReady
  expect((await snapshot(handle.frame)).pixels).toBeGreaterThan(0)
  expect(boot.dataset.startupFailure).toBeUndefined()
})

it('lets actual content win before an animation frame is ready, without a timed display floor', async () => {
  await page.viewport(1280, 840); await media(false); mountHtml('light')
  const handle = startStartupMotion({hold:true,attemptId:'content-first-proof'})!
  commitStartupContent()
  await expect(handle.frameReady).rejects.toMatchObject({name:'AbortError'})
  expect(document.querySelector('[data-gugu-boot]')).toBeNull()
  expect(startStartupMotion()).toBeNull()
})

it('restores the existing login brand if native OFF discards startup during provider loading', async () => {
  await page.viewport(1280, 840); await media(false); mountHtml('light')
  vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
  const original = startStartupMotion()!.frame
  root!.render(<StartupMotionBoundary><LoginPage /></StartupMotionBoundary>)
  await until('login owns the still-pending provider placeholder', () => !!rootHost!.querySelector('.gugu-auth-placeholder'))
  discardStartupMotion()
  await until('the ordinary login brand has resumed', () => !!rootHost!.querySelector('.gugu-auth-motion iframe'))
  expect(document.querySelector('[data-gugu-boot]')).toBeNull()
  expect(rootHost!.querySelector('.gugu-auth-motion iframe')).not.toBe(original)
})

for (const width of [411, 360]) it(`keeps the approved virtual canvas and limits only its final visual size: ${width}px`, async () => {
  await page.viewport(width, 840); await media(false); mountHtml('light')
  const handle = startStartupMotion({ hold: true })!
  await handle.frameReady
  const canvas = await snapshot(handle.frame)
  const scale = handle.frame.getBoundingClientRect().width / handle.frame.clientWidth
  expect(canvas.width).toBe(592)
  expect(canvas.width * scale).toBeCloseTo(Math.min(355.2, width - 48))
  expect(canvas.height * scale).toBeCloseTo(160 * Math.min(.6, (width - 48) / 592))
})

it('finishes a held frame as the existing wide login brand when content wins before native reveal', async () => {
  await page.viewport(1280, 840); await media(false); mountHtml('light')
  vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ external: { google: true } })))
  deferStartupMotion()
  const handle = startStartupMotion({ hold: true, attemptId: 'wide-content-wins' })!
  root!.render(<StartupMotionBoundary><FullScreenLoader /></StartupMotionBoundary>)
  await handle.frameReady
  const first = await snapshot(handle.frame)
  expect(first.phase).toBe('entering')
  root!.render(<StartupMotionBoundary><LoginPage /></StartupMotionBoundary>)
  await until('content has claimed the existing wide brand frame', () => document.querySelector<HTMLElement>('[data-gugu-boot]')?.style.zIndex === '1')
  const brand = await snapshot(handle.frame)
  expect(brand.phase).toBe('settled')
  expect(brand.timeOrigin).toBe(first.timeOrigin)
  expect(document.querySelectorAll('iframe[title=gugu]')).toHaveLength(1)
  const sampleStart = performance.now()
  await until('the existing brand wave has advanced', () => performance.now() - sampleStart > 650)
  expect((await snapshot(handle.frame)).hash).not.toBe(brand.hash)
})

it('restores the ordinary loader after the real sandbox reports a runtime error even after frame readiness', async () => {
  await page.viewport(1280, 840); await media(false); const boot = mountHtml('light')
  const handle = startStartupMotion()!
  root!.render(<StartupMotionBoundary><FullScreenLoader /></StartupMotionBoundary>)
  await handle.frameReady
  await session().send('Runtime.evaluate', {
    contextId: await world(handle.frame),
    // A DOM script runs in the animation document's own realm, unlike a direct
    // isolated-world ErrorEvent. Exercise its reporter and the real parent channel.
    expression: `(() => { const script = document.createElement('script'); script.textContent = "window.dispatchEvent(new ErrorEvent('error', { message: 'brand renderer failed after readiness' }))"; document.body.append(script); script.remove(); })()`,
  })
  await until('the animation document has reported its own failure', () => boot.dataset.startupFailure?.includes('brand renderer failed after readiness') === true)
  await until('runtime failure restores the ordinary loading indicator', () => !!rootHost!.querySelector('[data-testid=loading-indicator]'))
  expect(document.querySelector('[data-gugu-boot]')).toBeNull()
  expect(rootHost!.querySelector('[data-testid=full-screen-loader]')?.getAttribute('aria-busy')).toBe('true')
})

for (const width of [360, 412, 480, 640, 1280]) for (const theme of ['light', 'dark']) for (const reduce of [false, true])
  it(`centers the actual startup wordmark in the viewport: ${width}px ${theme} reduced=${reduce}`, async () => {
    await page.viewport(width, 867); await media(reduce); mountHtml(theme)
    const handle = startStartupMotion({ hold: true })!
    await handle.frameReady
    const canvas = await snapshot(handle.frame)
    const frame = handle.frame.getBoundingClientRect()
    const scale = frame.width / handle.frame.clientWidth
    const centerX = frame.left + (canvas.left + canvas.width / 2) * scale
    const centerY = frame.top + (canvas.top + canvas.height / 2) * scale
    expect(canvas.width).toBe(592)
    expect(canvas.width * scale).toBeCloseTo(Math.min(355.2, width - 48))
    expect(Math.abs(centerX - innerWidth / 2), `wordmark center ${centerX}, viewport center ${innerWidth / 2}`).toBeLessThan(1)
    expect(Math.abs(centerY - innerHeight / 2), `wordmark vertical center ${centerY}, viewport center ${innerHeight / 2}`).toBeLessThan(1)
  })
