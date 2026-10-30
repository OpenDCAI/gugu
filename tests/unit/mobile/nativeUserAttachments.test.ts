import { expect, it, vi } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { nativeUserAttachmentCommands } from '../../../apps/desktop/src/mobile/agent-watch/native-user-attachments'

it('resolves the recorded user image for both the thumbnail and the full-size viewer', async () => {
  const ref = { id: 'immutable-image', name: 'photo.png', mimeType: 'image/png' as const }
  const turns: TranscriptTurn[] = [{ id: 'c:turn:s28', seq: 28, initiator: 'user', items: [
    { kind: 'message', id: 'c:turn:s28:message:user', seq: 0, role: 'user', text: 'caption', attachments: [ref] },
  ] }]
  const readImage = vi.fn(async () => 'data:image/png;base64,AQID'), openImage = vi.fn(), openFile = vi.fn(), onError = vi.fn()
  const commands = nativeUserAttachmentCommands({ turns: () => turns, readImage, readPathImage: vi.fn(), openImage, openFile, onError, unavailable: () => 'missing' })
  expect(await commands.resolveAttachment!(ref)).toBe('data:image/png;base64,AQID')
  commands.onViewAttachment!({ attachment: { ...ref, kind: 'image' }, itemId: turns[0]!.items[0]!.id, source: 'user-message' })
  await vi.waitFor(() => expect(openImage).toHaveBeenCalledWith('data:image/png;base64,AQID', ref.name, undefined))
  expect(readImage).toHaveBeenCalledExactlyOnceWith(turns[0]!.items[0]!.id, ref.id)
  expect(onError).not.toHaveBeenCalled()
  commands.onViewAttachment!({ attachment: { id: 'path:/staged/document.txt', name: 'document.txt', kind: 'file' }, itemId: 'file-input', source: 'user-message' })
  expect(openFile).toHaveBeenCalledWith('/staged/document.txt')
})

it('does not invent a source for a missing ref and shows preview failures', async () => {
  const readImage = vi.fn(), openImage = vi.fn(), onError = vi.fn()
  const commands = nativeUserAttachmentCommands({ turns: () => [], readImage, readPathImage: vi.fn(), openImage, openFile: vi.fn(), onError, unavailable: () => 'missing' })
  expect(await commands.resolveAttachment!({ id: 'unknown', name: 'photo.png' })).toBeNull()
  commands.onViewAttachment!({ attachment: { id: 'unknown', name: 'photo.png' }, itemId: 'unknown-item', source: 'user-message' })
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'missing' })))
  expect(readImage).not.toHaveBeenCalled()
  expect(openImage).not.toHaveBeenCalled()
})
