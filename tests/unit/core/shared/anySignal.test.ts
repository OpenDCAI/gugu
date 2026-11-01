import { afterEach, describe, expect, it, vi } from 'vitest'
import { anySignal } from '../../../../packages/core/src/shared/anySignal'

// Android System WebView before 116 has no AbortSignal.any; every case runs with it and without it.
const native = Object.getOwnPropertyDescriptor(AbortSignal, 'any')
afterEach(() => { if (native) Object.defineProperty(AbortSignal, 'any', native) })

describe.each([
  ['native AbortSignal.any', () => {}],
  ['WebView without AbortSignal.any', () => { delete (AbortSignal as { any?: unknown }).any; expect('any' in AbortSignal).toBe(false) }],
])('anySignal with %s', (_name, setup) => {
  it('aborts when any source aborts, with that source reason', () => {
    setup()
    const a = new AbortController(), b = new AbortController()
    const combined = anySignal([a.signal, b.signal])
    expect(combined.aborted).toBe(false)
    b.abort('stopped by b')
    expect(combined.aborted).toBe(true)
    expect(combined.reason).toBe('stopped by b')
    a.abort('later')
    expect(combined.reason).toBe('stopped by b')
  })

  it('is already aborted when a source already is', () => {
    setup()
    const a = new AbortController()
    a.abort('early')
    const combined = anySignal([new AbortController().signal, a.signal])
    expect(combined.aborted).toBe(true)
    expect(combined.reason).toBe('early')
  })

  it('skips absent sources and returns a single source as it is', () => {
    setup()
    const a = new AbortController()
    expect(anySignal([undefined, a.signal, null])).toBe(a.signal)
    expect(anySignal([]).aborted).toBe(false)
  })
})

describe('anySignal without AbortSignal.any', () => {
  it('detaches from every source once it aborts, so a long-lived source keeps nothing', () => {
    delete (AbortSignal as { any?: unknown }).any
    const lifetime = new AbortController(), request = new AbortController()
    const removed = vi.spyOn(lifetime.signal, 'removeEventListener')
    anySignal([lifetime.signal, request.signal])
    request.abort()
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})
