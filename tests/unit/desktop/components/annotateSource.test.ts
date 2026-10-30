import { beforeEach, describe, expect, it, vi } from 'vitest'
import { annotationItem } from '../../../../apps/desktop/src/components/imageAnnotate/annotateSource'
import type { ImageViewerItem } from '../../../../apps/desktop/src/lib/imageViewer'

const calls = vi.hoisted(() => ({ session: vi.fn(), compose: vi.fn() }))
vi.mock('@/lib/sessionPublication', () => ({ getRendererSession: calls.session }))
vi.mock('@/session/shared/extensions/app-send-core', () => ({ composeInChat: calls.compose }))
beforeEach(() => { vi.clearAllMocks(); calls.session.mockReturnValue({ access_token: 'test-token', user: { id: 'person' } }) })
describe('annotation origin', () => {
  it('preserves an explicit original chat/message and does not infer context for a source-free image', async () => {
    const original = { url: 'blob:image', alt: 'a.png', source: { chatId: 'chat', messageId: 'message' } }
    await expect(annotationItem(original)).resolves.toBe(original)
    const task = { url: 'blob:task-image', alt: 'task.png' }
    await expect(annotationItem(task)).resolves.toBe(task)
    expect(calls.session).not.toHaveBeenCalled()
    expect(calls.compose).not.toHaveBeenCalled()
  })
  it('reads a folder image actual chat through the existing file-reference contract without inventing a message', async () => {
    calls.compose.mockResolvedValueOnce({ chatId: 'actual-file-chat', refs: [] })
    const file: ImageViewerItem = { url: 'blob:file', alt: 'file.png', resource: { kind: 'file', target: { kind: 'file', itemId: 'file-id', version: 7 } } }
    await expect(annotationItem(file)).resolves.toMatchObject({ source: { chatId: 'actual-file-chat' } })
    const [platform, request] = calls.compose.mock.calls[0]
    expect(request).toEqual({ text: '', refs: [{ file: { id: 'file-id' }, version: 7 }] })
    await expect(platform.account()).resolves.toEqual({ token: 'test-token', userId: 'person' })
    expect((await annotationItem({ ...file, source: { chatId: 'actual-file-chat' } })).source).not.toHaveProperty('messageId')
  })
  it('propagates a refused origin read instead of opening into the background chat', async () => {
    calls.compose.mockRejectedValueOnce(new Error('membership refused'))
    await expect(annotationItem({ url: 'blob:file', alt: 'file.png', resource: { kind: 'file', target: { kind: 'file', itemId: 'file-id' } } }))
      .rejects.toThrow('membership refused')
  })
})
