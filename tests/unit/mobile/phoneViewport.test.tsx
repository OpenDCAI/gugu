// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePhoneViewport, type PhoneViewport } from '../../../apps/desktop/src/mobile/usePhoneViewport'
import { createReactHarness } from '../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
let viewport: EventTarget & { height: number; offsetTop: number; scale: number }
let latest: PhoneViewport
let hidden = false

function Probe({ enabled = true }: { enabled?: boolean }) {
  latest = usePhoneViewport(enabled)
  return <><textarea /><input readOnly /><button>Done</button></>
}

beforeEach(() => {
  harness = createReactHarness()
  hidden = false
  viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 })
  vi.stubGlobal('visualViewport', viewport as VisualViewport)
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => hidden ? 'hidden' : 'visible')
  vi.stubGlobal('innerHeight', 800)
})
afterEach(() => {
  harness.cleanup()
  vi.unstubAllGlobals()
})

const update = async (target: EventTarget, name: string) => act(async () => { target.dispatchEvent(new Event(name)) })
const keyboard = async (visible: unknown) => act(async () => { window.dispatchEvent(Object.assign(new Event('gugu:phone-keyboard'), { visible })) })

describe('phone shell visible viewport', () => {
  it('keeps desktop sizing and focus untouched while disabled, including a later disable', async () => {
    await harness.render(<Probe enabled={false} />)
    await act(async () => { harness.container.querySelector('textarea')!.focus() })
    viewport.height = 400
    await update(viewport, 'resize')
    expect(latest).toEqual({ viewportHeight: null, viewportOffsetTop: 0, inputFocused: false, keyboardVisible: null })
    await harness.render(<Probe />)
    expect(latest.viewportHeight).toBe(400)
    await harness.render(<Probe enabled={false} />)
    expect(latest.inputFocused).toBe(false)
    expect(latest.viewportHeight).toBeNull()
  })

  it('uses real visual height and pan offset, resetting input focus on blur without guessing an IME', async () => {
    await harness.render(<Probe />)
    await act(async () => { harness.container.querySelector('textarea')!.focus() })
    viewport.height = 430
    viewport.offsetTop = 24
    await update(viewport, 'resize')
    expect(latest).toEqual({ viewportHeight: 430, viewportOffsetTop: 24, inputFocused: true, keyboardVisible: null })
    viewport.offsetTop = 36
    await update(viewport, 'scroll')
    expect(latest.viewportOffsetTop).toBe(36)
    await act(async () => { harness.container.querySelector('button')!.focus(); await Promise.resolve() })
    expect(latest.inputFocused).toBe(false)
    expect(latest.viewportHeight).toBe(430)
    viewport.height = 800
    viewport.offsetTop = 0
    await update(viewport, 'resize')
    expect(latest.viewportHeight).toBe(800)
  })

  it('does not mistake an ordinary floating-window resize or a readonly field for keyboard focus', async () => {
    await harness.render(<Probe />)
    viewport.height = 320
    await update(viewport, 'resize')
    await act(async () => { harness.container.querySelector('input')!.focus() })
    expect(latest).toEqual({ viewportHeight: 320, viewportOffsetTop: 0, inputFocused: false, keyboardVisible: null })
  })

  it('follows rotation rather than keeping the tallest previous screen and rejects zero/invalid heights', async () => {
    await harness.render(<Probe />)
    viewport.height = 390
    await update(window, 'orientationchange')
    expect(latest.viewportHeight).toBe(390)
    vi.stubGlobal('innerHeight', 390)
    viewport.height = 0
    viewport.offsetTop = Number.NaN
    await update(viewport, 'resize')
    expect(latest).toEqual({ viewportHeight: 390, viewportOffsetTop: 0, inputFocused: false, keyboardVisible: null })
    vi.stubGlobal('innerHeight', 0)
    await update(window, 'resize')
    expect(latest.viewportHeight).toBeNull()
  })

  it('drops hidden snapshots and rereads the current viewport on restore instead of retaining a half screen', async () => {
    await harness.render(<Probe />)
    await act(async () => { harness.container.querySelector('textarea')!.focus() })
    viewport.height = 420
    await update(viewport, 'resize')
    hidden = true
    await update(document, 'visibilitychange')
    expect(latest).toEqual({ viewportHeight: null, viewportOffsetTop: 0, inputFocused: false, keyboardVisible: null })
    await act(async () => { harness.container.querySelector('textarea')!.blur() })
    hidden = false
    viewport.height = 800
    await update(document, 'visibilitychange')
    expect(latest).toEqual({ viewportHeight: 800, viewportOffsetTop: 0, inputFocused: false, keyboardVisible: null })
    viewport.height = 720
    await update(window, 'pageshow')
    expect(latest.viewportHeight).toBe(720)
  })

  it('uses window resize where visualViewport is unavailable and leaves pinch zoom to the browser', async () => {
    await harness.render(<Probe />)
    viewport.scale = 2
    viewport.height = 400
    viewport.offsetTop = 50
    await update(viewport, 'resize')
    expect(latest.viewportHeight).toBe(800)
    expect(latest.viewportOffsetTop).toBe(0)
    vi.stubGlobal('visualViewport', null)
    vi.stubGlobal('innerHeight', 500)
    await update(window, 'resize')
    expect(latest.viewportHeight).toBe(500)
  })

  it('accepts the native IME hiding while the textarea remains focused, without inferring it from viewport height', async () => {
    await harness.render(<Probe />)
    const field = harness.container.querySelector('textarea')!
    await act(async () => { field.focus() })
    await keyboard(true)
    expect(latest.inputFocused).toBe(true)
    expect(latest.keyboardVisible).toBe(true)
    await keyboard(false)
    expect(document.activeElement).toBe(field)
    expect(latest.inputFocused).toBe(true)
    expect(latest.keyboardVisible).toBe(false)
    viewport.height = 400
    await update(viewport, 'resize')
    expect(latest.keyboardVisible, 'a floating-window resize cannot override real IME state').toBe(false)
    await keyboard('true')
    expect(latest.keyboardVisible, 'malformed native values are ignored').toBe(false)
  })

  it('invalidates native state while hidden and requires a fresh observation on resume', async () => {
    await harness.render(<Probe />)
    await keyboard(true)
    hidden = true
    await update(document, 'visibilitychange')
    expect(latest.keyboardVisible).toBeNull()
    await keyboard(false)
    hidden = false
    await update(document, 'visibilitychange')
    expect(latest.keyboardVisible, 'a hidden event cannot be reused as a current observation').toBeNull()
    await keyboard(false)
    expect(latest.keyboardVisible).toBe(false)
  })

  it('removes native listeners on unmount or disable and does not carry their signal into a new activation', async () => {
    await harness.render(<Probe />)
    await keyboard(true)
    await harness.render(null)
    await keyboard(false)
    await harness.render(<Probe />)
    expect(latest.keyboardVisible).toBeNull()
    await keyboard(true)
    expect(latest.keyboardVisible).toBe(true)
    await harness.render(<Probe enabled={false} />)
    await keyboard(true)
    expect(latest.keyboardVisible).toBeNull()
    await harness.render(<Probe />)
    expect(latest.keyboardVisible).toBeNull()
  })
})
