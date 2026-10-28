// @vitest-environment jsdom
// 聊天里的缩略图重新挂载(切会话回来、120 行窗口换回来)不再先等一次 file-resolve:同一个不可变来源在本次运行里只解析一次。
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import type { AttachmentSource } from '@gugu/core/shared/ui/attachmentModels'

const f = vi.hoisted(() => ({ resolve: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/fileAccess', () => ({
  resolveFile: f.resolve,
  fileReader: () => ({ accountId: 'account-1', actorId: 'account-1' }),
  fileReadSignal: () => undefined,
  attachmentCache: async () => ({ match: async () => undefined, put: async () => undefined }),
  attachmentCacheOrigin: 'https://attachments.gugu.invalid',
}))

import { useAttachmentObjectUrl } from '../../../../apps/desktop/src/lib/attachmentBytes'
import { attachmentQueryClient } from '../../../../apps/desktop/src/lib/attachmentQueryClient'

const revision = { sha256: 'a'.repeat(64), size_bytes: 3, content_type: 'image/png', source: 'managed-object', width: 4, height: 3 }
function Thumb({ source }: { source: AttachmentSource }) {
  const view = useAttachmentObjectUrl(source, 'thumb')
  return createElement('span', { 'data-status': view.status })
}
const status = (harness: ReturnType<typeof createReactHarness>) => harness.container.querySelector('span')?.getAttribute('data-status')

describe('inline image thumbnails across remounts', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => {
    attachmentQueryClient.clear()
    f.resolve.mockReset().mockImplementation(async () => ({
      status: 'ready', purpose: 'preview', revision, dispose: async () => undefined, content: async () => new Blob(['png'], { type: 'image/png' }),
    }))
    URL.createObjectURL = vi.fn(() => `blob:thumb-${Math.random()}`)
    URL.revokeObjectURL = vi.fn()
    harness = createReactHarness()
  })
  afterEach(() => harness.cleanup())

  const settle = () => vi.waitFor(() => expect(status(harness)).toBe('ready'))

  it('re-mounting the same message image reuses this run\'s thumbnail: no second file-resolve', async () => {
    const source: AttachmentSource = { kind: 'message', messageId: 'm-1' }
    await harness.render(createElement(Thumb, { source })); await settle()
    await harness.render(null)
    await harness.render(createElement(Thumb, { source })); await settle()
    expect(f.resolve).toHaveBeenCalledTimes(1)
    // each mount owns (and revokes) its own object URL
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2)
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
  })

  it('a different source still resolves', async () => {
    await harness.render(createElement(Thumb, { source: { kind: 'message', messageId: 'm-1' } })); await settle()
    await harness.render(createElement(Thumb, { source: { kind: 'item', itemId: 'i-1', version: 2 } })); await settle()
    expect(f.resolve).toHaveBeenCalledTimes(2)
  })
})
