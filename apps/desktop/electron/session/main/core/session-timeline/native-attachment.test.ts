import { describe, expect, it, vi } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';
import { nativeAttachmentDataUrl } from './native-attachment';

const ref = { id: 'immutable-image', name: 'photo.png', mimeType: 'image/png' as const };
const turn: TranscriptTurn = { id: 'conversation:turn:s28', seq: 28, initiator: 'user', items: [
  { id: 'conversation:turn:s28:message:user', seq: 0, kind: 'message', role: 'user', text: 'caption', attachments: [ref] },
] };
const input = { conversationId: 'conversation', itemId: turn.items[0]!.id, attachmentId: ref.id };
describe('native user attachment read', () => {
  it('returns image bytes for a recorded attachment without changing the caption or identity', async () => {
    const readTurn = vi.fn(async () => structuredClone(turn));
    const download = vi.fn(async () => ({ ref, data: new Uint8Array([1, 2, 3]) }));
    expect(await nativeAttachmentDataUrl(input, { readTurn, download })).toBe('data:image/png;base64,AQID');
    expect(download).toHaveBeenCalledWith(ref.id);
    expect(turn.items[0]).toMatchObject({ id: input.itemId, text: 'caption' });
  });
  it.each([{ ...input, itemId: 'another-message' }, { ...input, attachmentId: 'another-image' }])('refuses unrelated identities before downloading', async request => {
    const download = vi.fn();
    await expect(nativeAttachmentDataUrl(request, { readTurn: async () => turn, download })).rejects.toThrow(/不属于/);
    expect(download).not.toHaveBeenCalled();
  });
  it('keeps a missing or unreadable object as an explicit failure', async () => {
    await expect(nativeAttachmentDataUrl(input, { readTurn: async () => turn, download: async () => { throw new Error('object missing'); } })).rejects.toThrow('object missing');
  });
});
