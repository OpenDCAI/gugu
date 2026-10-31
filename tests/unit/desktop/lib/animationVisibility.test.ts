// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { ANIMATION_WINDOW_SEEN_EVENT, isAnimationWindowVisible, observeAnimationViewport } from '@gugu/session-shared/animation-visibility'

it('shares root window state and viewport observers without reading styles or observing ancestors', () => {
  const observers: Array<{ intersect: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void; rootMargin: string; unobserve: ReturnType<typeof vi.fn> }> = []
  vi.stubGlobal('IntersectionObserver', class {
    unobserve = vi.fn()
    constructor(intersect: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void, options: { rootMargin: string }) {
      observers.push({ intersect, rootMargin: options.rootMargin, unobserve: this.unobserve })
    }
    observe() {}
  })
  vi.stubGlobal('MutationObserver', class { constructor() { throw new Error('Visibility must not observe ancestor mutations') } })
  let hidden = false
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  const first = document.createElement('span')
  const second = document.createElement('canvas')
  const third = document.createElement('canvas')
  first.checkVisibility = () => { throw new Error('Visibility must not force style resolution') }
  first.getBoundingClientRect = () => { throw new Error('Visibility must not force layout') }
  const text = vi.fn(), avatar = vi.fn()
  const stopText = observeAnimationViewport(first, text)
  const stopAvatar = observeAnimationViewport(second, avatar, '80px')
  const stopThird = observeAnimationViewport(third, vi.fn(), '80px')
  try {
    expect(observers.map((observer) => observer.rootMargin)).toEqual(['0px', '80px'])
    observers[0].intersect([{ target: first, isIntersecting: true }])
    observers[1].intersect([{ target: second, isIntersecting: true }])
    expect(text).toHaveBeenLastCalledWith(true)
    expect(avatar).toHaveBeenLastCalledWith(true)
    window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false }))
    expect(isAnimationWindowVisible()).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--gugu-animation-window-paused')).toBe('paused')
    // The one shared policy pauses JavaScript consumers as well as CSS clocks.
    expect(text).toHaveBeenLastCalledWith(false)
    expect(avatar).toHaveBeenLastCalledWith(false)
    window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }))
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    expect(isAnimationWindowVisible()).toBe(false)
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    expect(isAnimationWindowVisible()).toBe(true)
    expect(text).toHaveBeenLastCalledWith(true)
    expect(avatar).toHaveBeenLastCalledWith(true)
    expect(document.documentElement.style.getPropertyValue('--gugu-animation-window-paused')).toBe('initial')
    observers[0].intersect([{ target: first, isIntersecting: false }])
    expect(text).toHaveBeenLastCalledWith(false)
    expect(avatar).toHaveBeenLastCalledWith(true)
    stopText()
    text.mockClear()
    observers[0].intersect([{ target: first, isIntersecting: true }])
    expect(text).not.toHaveBeenCalled()
    expect(observers[0].unobserve).toHaveBeenCalledWith(first)
  } finally {
    stopText(); stopAvatar(); stopThird()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

it('keeps portal window state and viewport observers in the element owner document', () => {
  const frames = [document.createElement('iframe'), document.createElement('iframe')]
  frames.forEach((frame) => document.body.append(frame))
  const docs = frames.map((frame) => frame.contentDocument!)
  const observers: Array<{ doc: Document; intersect: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void }> = []
  for (const doc of docs) {
    vi.spyOn(doc, 'hidden', 'get').mockReturnValue(false)
    Object.defineProperty(doc.defaultView!, 'IntersectionObserver', { configurable: true, value: class {
      constructor(intersect: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void) { observers.push({ doc, intersect }) }
      observe() {}
      unobserve() {}
    } })
  }
  const first = docs[0].createElement('span'), second = docs[1].createElement('span')
  const firstViewport = vi.fn(), secondViewport = vi.fn()
  const stops = [observeAnimationViewport(first, firstViewport), observeAnimationViewport(second, secondViewport)]
  try {
    expect(observers.map((observer) => observer.doc)).toEqual(docs)
    isAnimationWindowVisible()
    observers[0].intersect([{ target: first, isIntersecting: true }])
    observers[1].intersect([{ target: second, isIntersecting: true }])
    firstViewport.mockClear(); secondViewport.mockClear()
    window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false }))
    expect(isAnimationWindowVisible()).toBe(false)
    expect(docs.map((doc) => isAnimationWindowVisible(doc))).toEqual([true, true])
    expect(firstViewport).not.toHaveBeenCalled()
    expect(secondViewport).not.toHaveBeenCalled()
    docs[0].defaultView!.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false }))
    expect(docs.map((doc) => isAnimationWindowVisible(doc))).toEqual([false, true])
    expect(docs[0].documentElement.style.getPropertyValue('--gugu-animation-window-paused')).toBe('paused')
    expect(docs[1].documentElement.style.getPropertyValue('--gugu-animation-window-paused')).toBe('initial')
    expect(firstViewport).toHaveBeenLastCalledWith(false)
    expect(secondViewport).not.toHaveBeenCalled()
    docs[0].defaultView!.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }))
    expect(isAnimationWindowVisible(docs[0])).toBe(true)
    expect(firstViewport).toHaveBeenLastCalledWith(true)
    stops[0]()
    firstViewport.mockClear()
    docs[0].defaultView!.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false }))
    expect(firstViewport).not.toHaveBeenCalled()
  } finally {
    stops.forEach((stop) => stop())
    window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }))
    frames.forEach((frame) => frame.remove())
    vi.restoreAllMocks()
  }
})

it('keeps the existing no-IntersectionObserver viewport behavior while still stopping on native hide', () => {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const doc = frame.contentDocument!
  vi.spyOn(doc, 'hidden', 'get').mockReturnValue(false)
  const changed = vi.fn()
  const stop = observeAnimationViewport(doc.createElement('span'), changed)
  try {
    expect(changed).toHaveBeenLastCalledWith(true)
    doc.defaultView!.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false }))
    expect(changed).toHaveBeenLastCalledWith(false)
    doc.defaultView!.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }))
    expect(changed).toHaveBeenLastCalledWith(true)
    stop(); changed.mockClear()
    doc.defaultView!.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false }))
    expect(changed).not.toHaveBeenCalled()
  } finally { stop(); frame.remove(); vi.restoreAllMocks() }
})
