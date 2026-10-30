import type { AttachmentStore } from '../runtime/attachment-store';
import type { ResolvePromptAttachment } from '../session/cell-deps';

/** A local-file input must keep a downloadable copy, just like an uploaded image. */
export function createPromptAttachmentResolver(store: AttachmentStore): ResolvePromptAttachment {
  return async attachment => {
    const id = attachment.type === 'attachment' ? attachment.id : (await store.put({
      originalPath: attachment.originalPath, name: attachment.name, mimeType: attachment.mimeType,
    })).id;
    const stored = await store.get(id);
    if (!stored) throw new Error('Submitted image attachment could not be resolved');
    return { data: Buffer.from(stored.data).toString('base64'), mimeType: stored.ref.mimeType, ref: stored.ref };
  };
}
