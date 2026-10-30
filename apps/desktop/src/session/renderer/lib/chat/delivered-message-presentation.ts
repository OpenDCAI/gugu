import { hasAttachmentDeliveryHints, type ChatState, type DeliveryMessagePresentation } from '@gugu/session-chat-ui';
import type { MessageItem } from '@gugu/core/shared/types/chat';
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels';
import { createEffect, createRoot } from 'solid-js';

export function originalMessagePresentation(message: MessageItem): DeliveryMessagePresentation | null {
  if (message.content_type !== 'attachment' || message.retracted_at) return null;
  const attachment = parseAttachmentContent(message.content, message);
  if (!attachment) return null;
  const href = attachment.source.kind === 'item' ? `gugu-file://${attachment.source.itemId}?v=${attachment.source.version}`
    : `gugu-message-file://${message.id}`;
  return { text: attachment.caption ?? '', attachments: [{ id: `gugu-message-file://${message.id}`, name: attachment.fileName,
    kind: attachment.kind === 'image' ? 'image' : 'file', href }] };
}

/** The task page and both DM hosts resolve the same source ID with the current person's permissions. */
export function connectDeliveredMessagePresentation(state: ChatState, load: (id: string) => Promise<MessageItem | null>, onError: (id: string, error: unknown) => void): () => void {
  const requested = new Set<string>(), results = new Map(state.session.state.deliveredMessages);
  let live = true;
  const stop = createRoot(dispose => {
    createEffect(() => {
      const turns = [...state.transcript.history.get(), ...(state.transcript.state.activeTurnSnapshot ? [state.transcript.state.activeTurnSnapshot] : [])];
      for (const turn of turns) for (const item of turn.items) {
        if (item.kind !== 'message' || item.role !== 'user') continue;
        for (const segment of readDeliveryEnvelope(item.text)?.segments ?? []) {
          const id = segment.facts?.messageId?.replace(/^msg:/, '');
          // Plain text needs no extra read. Attachment transport hints are not a presentation.
          if (!id || requested.has(id) || !hasAttachmentDeliveryHints(segment.body)) continue;
          requested.add(id);
          void load(id).then(message => {
            if (!live || !message || message.id !== id) return;
            const presentation = originalMessagePresentation(message);
            if (presentation) { results.set(id, presentation); state.session.setDeliveredMessages(new Map(results)); }
          }).catch(error => { if (live) onError(id, error); });
        }
      }
    });
    return dispose;
  });
  return () => { live = false; stop(); };
}

export async function resolveDeliveredAttachment(id: string): Promise<string | null> {
  const messageId = /^gugu-message-file:\/\/([0-9a-f-]{36})$/i.exec(id)?.[1];
  if (!messageId) return null;
  const { attachmentBytes } = await import('@/lib/attachmentBytes');
  const result = await attachmentBytes({ kind: 'message', messageId }, 'thumb');
  if (result.status !== 'ready') return null;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(result.blob);
  });
}
