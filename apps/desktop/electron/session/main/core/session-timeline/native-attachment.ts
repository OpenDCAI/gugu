import type { AttachmentRef, TranscriptTurn } from '@gugu/session-core/acp/client';

export type NativeAttachmentRequest = { conversationId: string; itemId: string; attachmentId: string };

/** Only an attachment explicitly recorded on this session's user message may be downloaded. */
export async function nativeAttachmentDataUrl(input: NativeAttachmentRequest, deps: {
  readTurn(input: NativeAttachmentRequest): Promise<TranscriptTurn | null>;
  download(id: string): Promise<{ ref: AttachmentRef; data: Uint8Array }>;
}): Promise<string> {
  const turn = await deps.readTurn(input);
  const item = turn?.items.find(item => item.id === input.itemId);
  const ref = item?.kind === 'message' && item.role === 'user'
    ? item.attachments?.find(attachment => attachment.id === input.attachmentId) : undefined;
  if (!ref) throw new Error('这件图片附件不属于该会话的用户消息');
  const stored = await deps.download(ref.id);
  if (stored.ref.id !== ref.id || stored.ref.mimeType !== ref.mimeType) throw new Error('图片附件记录不一致');
  return `data:${stored.ref.mimeType};base64,${Buffer.from(stored.data).toString('base64')}`;
}
