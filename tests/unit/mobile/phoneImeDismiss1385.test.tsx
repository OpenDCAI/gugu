// @vitest-environment jsdom
import { act } from 'react'
import { createPortal } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { platform } from '../../../apps/desktop/src/platform'
import { usePhoneImeDismiss } from '../../../apps/desktop/src/mobile/usePhoneImeDismiss'
import { createReactHarness } from '../../support/testHarness'

let h: ReturnType<typeof createReactHarness>
const kind = Object.getOwnPropertyDescriptor(platform, 'kind')!
const width = Object.getOwnPropertyDescriptor(window, 'innerWidth')!
const setKind = (value: string) => Object.defineProperty(platform, 'kind', { configurable: true, value })
function Owner({ children }: { children?: React.ReactNode }) { usePhoneImeDismiss(); return children }
const tick = () => act(async () => { await vi.runOnlyPendingTimersAsync() })
const enter = (target: Element, init: KeyboardEventInit = {}) => act(async () => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }))
})
beforeEach(() => { vi.useFakeTimers(); setKind('capacitor'); h = createReactHarness() })
afterEach(() => { h.cleanup(); vi.useRealTimers(); Object.defineProperty(platform, 'kind', kind); Object.defineProperty(window, 'innerWidth', width) })

describe('one phone IME dismissal owner (#1385)', () => {
  it.each(['done', 'go', 'search', undefined] as const)('dismisses a single-line %s action without changing its value', async hint => {
    await h.render(<Owner><input enterKeyHint={hint} defaultValue="keep this" /></Owner>)
    const input = h.container.querySelector('input')!; input.focus()
    await enter(input)
    expect(document.activeElement).toBe(input)
    await tick()
    expect(document.activeElement).toBe(document.body)
    expect(input.value).toBe('keep this')
  })
  it.each(['search', 'email', 'tel', 'url', 'password', 'number', 'date'])('covers %s single-line inputs', async type => {
    await h.render(<Owner><input type={type} /></Owner>)
    const input = h.container.querySelector('input')!; input.focus()
    await enter(input); await tick()
    expect(document.activeElement).toBe(document.body)
  })
  it('covers later portaled fields even when their handler stops propagation and prevents default', async () => {
    const action = vi.fn((event: React.KeyboardEvent) => { event.preventDefault(); event.stopPropagation() })
    await h.render(<Owner />)
    await h.render(<Owner>{createPortal(<input onKeyDown={action} />, document.body)}</Owner>)
    const input = document.body.querySelector('input')!; input.focus()
    await enter(input); await tick()
    expect(action).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(document.body)
  })
  it.each([{ isComposing: true }, { keyCode: 229 }])('keeps composition Enter focused (%j)', async init => {
    await h.render(<Owner><input /></Owner>)
    const input = h.container.querySelector('input')!; input.focus()
    await enter(input, init); await tick()
    expect(document.activeElement).toBe(input)
  })
  it('honors composition events when a keyboard omits the isComposing flag', async () => {
    await h.render(<Owner><input /></Owner>)
    const input = h.container.querySelector('input')!; input.focus()
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    await enter(input); await tick()
    expect(document.activeElement).toBe(input)
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    await enter(input); await tick()
    expect(document.activeElement).toBe(document.body)
  })
  it('does not interrupt composition that starts before the deferred blur', async () => {
    await h.render(<Owner><input /></Owner>)
    const input = h.container.querySelector('input')!; input.focus()
    await enter(input)
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    await tick()
    expect(document.activeElement).toBe(input)
  })
  it('keeps textarea and contenteditable composer Enter behavior', async () => {
    const action = vi.fn()
    await h.render(<Owner><textarea onKeyDown={action} /><div contentEditable suppressContentEditableWarning tabIndex={0} onKeyDown={action} /></Owner>)
    for (const input of h.container.querySelectorAll<HTMLElement>('textarea,[contenteditable]')) {
      input.focus(); await enter(input); await tick()
      expect(document.activeElement).toBe(input)
    }
    expect(action).toHaveBeenCalledTimes(2)
  })
  it('leaves controls and non-IME shortcut keys alone', async () => {
    await h.render(<Owner><input type="checkbox" /><input /></Owner>)
    const [box, input] = h.container.querySelectorAll('input')
    box!.focus(); await enter(box!); await tick()
    expect(document.activeElement).toBe(box)
    input!.focus()
    for (const init of [{ key: 'Escape' }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { repeat: true }]) {
      await enter(input!, init); await tick()
      expect(document.activeElement).toBe(input)
    }
  })
  it('does not blur the next field when an existing action moves focus', async () => {
    await h.render(<Owner><input onKeyDown={event => (event.currentTarget.nextElementSibling as HTMLElement).focus()} /><input /></Owner>)
    const [first, next] = h.container.querySelectorAll('input'); first!.focus()
    await enter(first!); await tick()
    expect(document.activeElement).toBe(next)
  })
  it('never installs on desktop Electron, even at phone width', async () => {
    setKind('electron'); Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    await h.render(<Owner><input /></Owner>)
    const input = h.container.querySelector('input')!; input.focus()
    await enter(input); await tick()
    expect(document.activeElement).toBe(input)
  })
  it('removes the listener and pending work when the web shell becomes desktop', async () => {
    setKind('web'); Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    await h.render(<Owner><input /></Owner>)
    const input = h.container.querySelector('input')!; input.focus()
    await enter(input)
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
    await act(async () => { window.dispatchEvent(new Event('resize')) }); await tick()
    expect(document.activeElement).toBe(input)
    await enter(input); await tick()
    expect(document.activeElement).toBe(input)
  })
})
