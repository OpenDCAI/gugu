// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { peekStore } from '@/session/renderer/features/extensions/peek-store'

const image = vi.hoisted(() => vi.fn())
vi.mock('@/lib/attachmentBytes', () => ({ openAttachmentImage: image }))
const detail = { chatId: 'chat', itemId: 'photo', name: 'photo.png', typedName: 'photo.png', file: { document: false, contentType: 'image/png', version: 2, size: 8 }, choice: { kind: 'none' as const } }
afterEach(() => { peekStore.close(null, 'tab'); peekStore.close('session', 'tab'); vi.clearAllMocks() })

it.each([null, 'session'])('shares image opening for phone and desktop peek callers (session=%s)', (session) => {
  peekStore.open(session, 'tab', { kind: 'chat', detail })
  expect(image).toHaveBeenCalledWith({ kind: 'item', itemId: 'photo', version: 2 }, 'photo.png', { chatId: 'chat' })
  expect(peekStore.of(session, 'tab')).toBeNull()
})

it('keeps the existing pane path for other files', () => {
  const target = { kind: 'chat' as const, detail: { ...detail, name: 'report.pdf', file: { ...detail.file, contentType: 'application/pdf' } } }
  peekStore.open(null, 'tab', target)
  expect(peekStore.of(null, 'tab')).toBe(target)
  expect(image).not.toHaveBeenCalled()
})
