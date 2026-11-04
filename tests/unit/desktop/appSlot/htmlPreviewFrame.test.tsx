// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { until } from '../../../support/awaitCondition'
import { HtmlPreviewFrame, type HtmlPreviewRegistration } from '@/components/preview/HtmlPreviewFrame'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => harness.cleanup())

describe('shared HTML frame lifecycle', () => {
  it('keeps the old frame painted until the replacement restores scroll, then releases one registration', async () => {
    const update = vi.fn(async () => 'blob:updated')
    const release = vi.fn()
    const register = vi.fn(async (): Promise<HtmlPreviewRegistration> => ({ ok: true, url: 'blob:initial', update, release }))
    const onLink = vi.fn()
    const draw = (rawContent: string, reloadKey = 0) => harness.render(createElement(HtmlPreviewFrame, { fileName: 'report.html', rawContent, register, onLink, reloadKey }))
    await draw('<h1>one</h1>')
    const frame = harness.container.querySelector('iframe')!
    expect(frame.getAttribute('src')).toBe('blob:initial')
    expect(frame.hasAttribute('srcdoc')).toBe(false)
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(update).not.toHaveBeenCalled()
    await act(async () => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'gugu-preview-scroll', x: 0, y: 900 } })))
    await draw('<h1>two</h1>')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)) })
    const staged = harness.container.querySelectorAll('iframe')[1]!
    expect(frame.classList.contains('visible')).toBe(true)
    expect(staged.classList.contains('invisible')).toBe(true)
    const post = vi.spyOn(staged.contentWindow!, 'postMessage')
    await act(async () => staged.dispatchEvent(new Event('load')))
    expect(post).toHaveBeenCalledWith({ type: 'gugu-preview-restore-scroll', x: 0, y: 900 }, '*')
    await act(async () => window.dispatchEvent(new MessageEvent('message', { source: staged.contentWindow, data: { type: 'gugu-preview-restored' } })))
    expect(harness.container.querySelectorAll('iframe')).toHaveLength(1)
    expect(staged.classList.contains('visible')).toBe(true)
    await draw('<h1>two</h1>', 1)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)) })
    expect(register).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledTimes(2)
    expect(harness.container.querySelector('iframe')).toBe(staged)
    await act(async () => window.dispatchEvent(new MessageEvent('message', { source: window, data: { type: 'gugu-preview-link', href: 'https://forged.test' } })))
    expect(onLink).not.toHaveBeenCalled()
    await act(async () => window.dispatchEvent(new MessageEvent('message', { source: staged.contentWindow, data: { type: 'gugu-preview-link', href: 'https://example.com' } })))
    expect(onLink).toHaveBeenCalledWith('https://example.com')
    await harness.render(null)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('does not navigate for an unrelated file or unchanged resync; one changed burst updates once', async () => {
    let changed!: (paths?: readonly string[]) => void
    const subscribeChanges = (listener: typeof changed) => { changed = listener; return vi.fn() }
    const update = vi.fn(async () => 'blob:next')
    const assetsChanged = vi.fn(async (paths?: string[]) => paths?.includes('used.css') ?? false)
    const register = vi.fn(async (): Promise<HtmlPreviewRegistration> => ({ ok: true, url: 'blob:initial', update, release: vi.fn(), assetsChanged }))
    await harness.render(createElement(HtmlPreviewFrame, { fileName: 'report.html', rawContent: 'page', register, onLink: vi.fn(), subscribeChanges }))
    vi.useFakeTimers()
    try {
      await act(async () => { changed(['other.md', 'sub/shot.png']); await vi.advanceTimersByTimeAsync(210) })
      await act(async () => { changed(); await vi.advanceTimersByTimeAsync(210) })
      expect(update).not.toHaveBeenCalled()
      expect(harness.container.querySelectorAll('iframe')).toHaveLength(1)
      await act(async () => { changed(['used.css']); changed(['used.css']); await vi.advanceTimersByTimeAsync(210) })
      await act(async () => { await vi.advanceTimersByTimeAsync(210) })
      expect(update).toHaveBeenCalledExactlyOnceWith('page')
    } finally { vi.useRealTimers() }
  })

  it('shows edits made while registration is pending, and releases late results after unmount', async () => {
    let resolve!: (value: HtmlPreviewRegistration) => void
    const register = vi.fn(() => new Promise<HtmlPreviewRegistration>((done) => { resolve = done }))
    const update = vi.fn(async () => 'blob:edited')
    const release = vi.fn()
    const draw = (rawContent: string) => harness.render(createElement(HtmlPreviewFrame, { fileName: 'report.html', rawContent, register, onLink: vi.fn() }))
    await draw('initial')
    await draw('edited while opening')
    await act(async () => resolve({ ok: true, url: 'blob:initial', update, release }))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)) })
    expect(update).toHaveBeenCalledWith('edited while opening')
    await harness.render(null)
    expect(release).toHaveBeenCalledTimes(1)
    await draw('new file')
    await harness.render(null)
    await act(async () => resolve({ ok: true, url: 'blob:late', update, release }))
    expect(release).toHaveBeenCalledTimes(2)
    expect(harness.container.querySelector('iframe')).toBeNull()
  })

  it('shows registration failures and retries when the caller asks to reload', async () => {
    const register = vi.fn<(...args: string[]) => Promise<HtmlPreviewRegistration>>()
      .mockResolvedValueOnce({ ok: false, message: 'Host unavailable' })
      .mockResolvedValue({ ok: true, url: 'blob:recovered', update: vi.fn(), release: vi.fn() })
    const draw = (reloadKey: number) => harness.render(createElement(HtmlPreviewFrame, { fileName: 'report.html', rawContent: 'body', register, reloadKey, onLink: vi.fn() }))
    await draw(0)
    expect(harness.container.textContent).toContain('Host unavailable')
    expect(harness.container.querySelector('iframe')).toBeNull()
    await draw(1)
    await until('host recovery is displayed', () => harness.container.querySelector('iframe')?.getAttribute('src') === 'blob:recovered')
  })

  it('can retry an unavailable registration on workspace recovery without a fetched list yet', async () => {
    let changed!: (paths?: readonly string[]) => void
    const subscribeChanges = (listener: typeof changed) => { changed = listener; return vi.fn() }
    const register = vi.fn<(...args: string[]) => Promise<HtmlPreviewRegistration>>()
      .mockResolvedValueOnce({ ok: false, message: 'Host unavailable' })
      .mockResolvedValue({ ok: true, url: 'blob:recovered', update: vi.fn(), release: vi.fn() })
    await harness.render(createElement(HtmlPreviewFrame, { fileName: 'report.html', rawContent: 'body', register, subscribeChanges, onLink: vi.fn() }))
    expect(harness.container.textContent).toContain('Host unavailable')
    await act(async () => { changed(); await new Promise(resolve => setTimeout(resolve, 220)) })
    expect(register).toHaveBeenCalledTimes(2)
    expect(harness.container.querySelector('iframe')?.getAttribute('src')).toBe('blob:recovered')
  })
})
