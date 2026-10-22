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
  it('updates and reloads one registration without replacing its iframe, then releases it', async () => {
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
    await draw('<h1>two</h1>')
    await until('updated URL is visible', () => frame.getAttribute('src') === 'blob:updated')
    await draw('<h1>two</h1>', 1)
    expect(register).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledTimes(2)
    expect(harness.container.querySelector('iframe')).toBe(frame)
    await act(async () => window.dispatchEvent(new MessageEvent('message', { source: window, data: { type: 'gugu-preview-link', href: 'https://forged.test' } })))
    expect(onLink).not.toHaveBeenCalled()
    await act(async () => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'gugu-preview-link', href: 'https://example.com' } })))
    expect(onLink).toHaveBeenCalledWith('https://example.com')
    await harness.render(null)
    expect(release).toHaveBeenCalledTimes(1)
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
    expect(update).toHaveBeenCalledWith('edited while opening')
    await harness.render(null)
    expect(release).toHaveBeenCalledTimes(1)
    await draw('new file')
    await harness.render(null)
    await act(async () => resolve({ ok: true, url: 'blob:late', update, release }))
    expect(release).toHaveBeenCalledTimes(2)
    expect(harness.container.querySelector('iframe')).toBeNull()
  })
})
