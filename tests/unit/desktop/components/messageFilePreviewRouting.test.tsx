// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createReactHarness } from '../../../support/testHarness'

const boundary = vi.hoisted(() => ({ kind: 'capacitor', mobileApps: false, open: vi.fn() }))
vi.mock('@/platform', () => ({ platform: {
  get kind() { return boundary.kind },
  get capabilities() { return { mobileApps: boundary.mobileApps } },
} }))
vi.mock('@/lib/guguLinks', () => ({ openLinkTarget: boundary.open }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ error: vi.fn() }) }))
vi.mock('@/lib/attachmentBytes', () => ({ openAttachmentImage: vi.fn() }))
vi.mock('@/components/ui/sheetStack', () => ({ useBackLayer: () => () => true }))
vi.mock('@/components/ui/Sheet', () => ({ Sheet: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/components/chat/MessageFilePreview', () => ({
  MessageFilePreview: ({ file }: { file: { fileName: string } }) => createElement('div', { 'data-testid': 'file-preview' }, file.fileName),
}))

import { useMessageFilePreview } from '../../../../apps/desktop/src/components/chat/useMessageFilePreview'

const file = {
  kind: 'file' as const, fileName: 'report.txt', mimeType: 'text/plain', sizeBytes: 88,
  source: { kind: 'item' as const, itemId: 'test-file', version: 1 },
}
function Conversation() {
  const preview = useMessageFilePreview({ mobile: true, visible: true, closeRightSurfaces: () => {}, toast: vi.fn() })
  return createElement('div', null,
    createElement('button', { onClick: () => preview.open(file) }, 'report.txt'), preview.panel)
}
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  boundary.kind = 'capacitor'; boundary.mobileApps = false
  boundary.open.mockReset().mockResolvedValue(undefined)
})
afterEach(() => harness.cleanup())

describe('opening a chat file on each host', () => {
  it('opens the existing preview on iOS without requesting an unavailable App host', async () => {
    await harness.render(createElement(Conversation))
    await clickElement(harness.container.querySelector('button')!)
    expect(harness.container.querySelector('[data-testid="file-preview"]')?.textContent).toBe('report.txt')
    expect(boundary.open).not.toHaveBeenCalled()
  })
  it.each(['android', 'electron'])('preserves App-first opening on %s', async (host) => {
    boundary.kind = host === 'android' ? 'capacitor' : 'electron'
    boundary.mobileApps = host === 'android'
    await harness.render(createElement(Conversation))
    await clickElement(harness.container.querySelector('button')!)
    expect(boundary.open).toHaveBeenCalledWith({ kind: 'file', itemId: 'test-file' }, expect.any(Object))
    expect(harness.container.querySelector('[data-testid="file-preview"]')).toBeNull()
  })
  it('retains the built-in preview in the web shell', async () => {
    boundary.kind = 'web'
    await harness.render(createElement(Conversation))
    await clickElement(harness.container.querySelector('button')!)
    expect(harness.container.querySelector('[data-testid="file-preview"]')).not.toBeNull()
    expect(boundary.open).not.toHaveBeenCalled()
  })
})
