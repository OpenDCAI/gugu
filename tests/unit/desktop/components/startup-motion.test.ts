// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commitStartupContent, retainStartupMotion, startStartupMotion, deferStartupMotion, discardStartupMotion, subscribeStartupContentReady, hasStartupMotion } from '../../../../apps/desktop/src/lib/startup-motion'

beforeEach(() => {
  const host = document.createElement('div')
  host.setAttribute('data-gugu-boot', '')
  host.style.color = 'rgb(26, 28, 31)'
  host.style.backgroundColor = 'white'
  document.body.append(host)
})
afterEach(discardStartupMotion)

describe('HTML to React startup animation ownership', () => {
  it('attaches the complete sandboxed document once and reuses its frame', () => {
    const state = startStartupMotion()!
    expect(state.frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(state.frame.srcdoc).toContain('<canvas')
    expect(state.frame.srcdoc).not.toContain('__MOTION_RGB__')
    expect(startStartupMotion()!.frame).toBe(state.frame)
    expect(document.querySelectorAll('[data-gugu-boot] iframe')).toHaveLength(1)
  })

  it('keeps the HTML frame through the root commit and StrictMode effect reacquisition', async () => {
    const frame = startStartupMotion()!.frame
    const firstCleanup = retainStartupMotion()
    commitStartupContent()
    firstCleanup()
    const finalCleanup = retainStartupMotion()
    await Promise.resolve()
    expect(document.querySelector('[data-gugu-boot] iframe')).toBe(frame)
    finalCleanup()
    await Promise.resolve()
    expect(document.querySelector('[data-gugu-boot]')).toBeNull()
  })

  it('removes startup after a fast content commit without imposing a display delay', async () => {
    startStartupMotion()
    commitStartupContent()
    await Promise.resolve()
    expect(document.querySelector('[data-gugu-boot]')).toBeNull()
  })

  it('never creates another startup frame for later operation loaders', async () => {
    commitStartupContent()
    await Promise.resolve()
    expect(startStartupMotion()).toBeNull()
    retainStartupMotion()()
    expect(document.querySelector('[data-gugu-boot]')).toBeNull()
  })

  it('supports a settled first phase without changing an already running frame', () => {
    const frame = startStartupMotion({ initialPhase: 'settled' })!.frame
    expect(frame.srcdoc).toContain('data-initial-phase="settled"')
    expect(frame.srcdoc).not.toContain('__STARTUP_PHASE__')
    expect(startStartupMotion({ initialPhase: 'assemble' })!.frame).toBe(frame)
    expect(frame.srcdoc).toContain('data-initial-phase="settled"')
  })

  it('reserves an Android startup before native context resolves, while React may already retain it', async () => {
    deferStartupMotion()
    const release = retainStartupMotion()
    commitStartupContent()
    await Promise.resolve()
    expect(document.querySelector('iframe')).toBeNull()
    const handle = startStartupMotion({ initialPhase: 'assemble', hold: true, attemptId: 'android-launch' })!
    expect(handle.frame.srcdoc).toContain('data-held="true"')
    expect(handle.frame.srcdoc).toContain('data-initial-phase="assemble"')
    release()
    await Promise.resolve()
    expect(hasStartupMotion()).toBe(false)
    expect(startStartupMotion({ initialPhase: 'settled' })).toBeNull()
  })

  it('accepts readiness only from this frame and launch, and only then allows reveal', async () => {
    const handle = startStartupMotion({ hold: true, attemptId: 'current-launch' })!
    let ready = false
    void handle.frameReady.then(() => { ready = true })
    window.dispatchEvent(new MessageEvent('message', { source: window, data: { type: 'gugu-startup-painted', attemptId: 'current-launch' } }))
    window.dispatchEvent(new MessageEvent('message', { source: handle.frame.contentWindow, data: { type: 'gugu-startup-painted', attemptId: 'previous-launch' } }))
    await Promise.resolve()
    expect(ready).toBe(false)
    window.dispatchEvent(new MessageEvent('message', { source: handle.frame.contentWindow, data: { type: 'gugu-startup-painted', attemptId: 'current-launch' } }))
    await handle.frameReady
    expect(ready).toBe(true)
    expect(handle.frame.style.opacity).toBe('1')
    discardStartupMotion()
    handle.reveal() // An obsolete handoff cannot recreate or reveal a discarded frame.
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('publishes real content before removing the host and replays it to a late subscriber', async () => {
    deferStartupMotion()
    const calls: string[] = []
    subscribeStartupContentReady(() => calls.push(document.querySelector('[data-gugu-boot]') ? 'before-remove' : 'after-remove'))
    commitStartupContent()
    await Promise.resolve()
    subscribeStartupContentReady(() => calls.push('late'))
    expect(calls).toEqual(['before-remove', 'late'])
    expect(startStartupMotion()).toBeNull()
  })

  it('does not misreport local OFF or a discarded frame as ready content', async () => {
    deferStartupMotion()
    let calls = 0
    subscribeStartupContentReady(() => { calls++ })
    discardStartupMotion()
    commitStartupContent()
    await Promise.resolve()
    expect(calls).toBe(0)
    expect(hasStartupMotion()).toBe(false)
  })
})
