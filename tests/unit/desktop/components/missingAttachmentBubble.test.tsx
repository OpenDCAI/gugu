// @vitest-environment jsdom
import { act, createElement } from 'react'
import { notifyManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { MediaAttachmentBubble } from '../../../../apps/desktop/src/components/chat/MediaAttachmentBubble'
import { attachmentQueryClient } from '../../../../apps/desktop/src/lib/attachmentQueryClient'
import { MissingFileObjectError } from '@gugu/core/shared/fileResolver'
import type { ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels'

const f = vi.hoisted(() => ({ resolve: vi.fn() }))
vi.mock('@/lib/fileAccess', () => ({ resolveFile: f.resolve, fileReader: () => ({ accountId: 'user-1', actorId: 'user-1' }), fileReadSignal: () => undefined, attachmentCache: vi.fn(), attachmentCacheOrigin: 'https://fixture.invalid' }))
vi.mock('@/lib/chat', () => ({ chatService: { getMessageById: vi.fn() } }))
vi.mock('@/components/chat/sendAttachmentBatch', () => ({ sendAttachmentBatch: vi.fn() }))
vi.mock('@/components/extensionBundle/ExtensionBundleCard', () => ({ ExtensionBundleCard: () => null }))
vi.mock('@/components/markdown/Markdown', () => ({ Markdown: () => null }))
vi.mock('react-i18next', async original => {
  const zh = (await import('../../../../apps/desktop/src/i18n/locales/zh-CN/messaging')).default
  return { ...await original<object>(), useTranslation: () => ({ t: (key: string) => key.split('.').reduce<unknown>((value, part) => (value as Record<string, unknown>)?.[part], zh) ?? key }) }
})
const image: ParsedAttachment = { kind: 'image', fileName: 'missing.png', mimeType: 'image/png', sizeBytes: 123, source: { kind: 'message', messageId: 'missing' } }
describe('missing attachment card shared by desktop and phone', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => {
    harness = createReactHarness(); attachmentQueryClient.clear(); vi.clearAllMocks()
    notifyManager.setNotifyFunction(callback => { act(callback) })
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
      observe() { this.callback([{ isIntersecting: true }]) }
      disconnect() {}
    })
  })
  afterEach(() => { harness.cleanup(); attachmentQueryClient.clear(); notifyManager.setNotifyFunction(callback => callback()); vi.unstubAllGlobals() })
  async function render(meta = image) {
    await renderWithAppProviders(harness, createElement(MediaAttachmentBubble, { meta, messageId: 'missing', isMine: false }))
  }
  async function expectMissing() {
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(harness.container.textContent).toContain('已失效')
    })
    expect(harness.container.textContent).not.toContain('重试')
    expect(harness.container.querySelector('button:not(:disabled)')).toBeNull()
  }
  it.each(['image', 'file'] as const)('shows an explicitly missing %s as 已失效 without a retry action', async kind => {
    f.resolve.mockResolvedValue({ status: 'missing', sha256: null })
    await render(kind === 'image' ? image : { ...image, kind, fileName: 'missing.txt', mimeType: 'text/plain' })
    await expectMissing()
  })
  it('keeps a network failure retryable and makes a fresh real attempt on click', async () => {
    f.resolve.mockRejectedValue(new TypeError('Failed to fetch'))
    await render()
    await vi.waitFor(async () => { await act(async () => {}); expect(harness.container.textContent).toContain('重试') })
    expect(harness.container.textContent).not.toContain('已失效')
    f.resolve.mockResolvedValue({ status: 'missing', sha256: null })
    await act(async () => { harness.container.querySelector<HTMLButtonElement>('button:not(:disabled)')!.click() })
    await expectMissing()
    expect(f.resolve).toHaveBeenCalledTimes(2)
  })
  it('also shows missing when the server confirms absence after metadata was already ready', async () => {
    f.resolve.mockResolvedValue({ status: 'ready', revision: {}, content: async () => { throw new MissingFileObjectError() }, dispose: vi.fn() })
    await render(); await expectMissing()
  })
})
