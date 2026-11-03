import { ATTACHMENT_UPLOAD_CHUNK_BYTES, type AttachmentUploadSpec, type AttachmentUploadState, type AttachmentUploadChunk } from '@gugu/session-core/session-record/contract';

export type AttachmentUploadTransport = {
  begin(spec: AttachmentUploadSpec): Promise<AttachmentUploadState>;
  status(spec: AttachmentUploadSpec): Promise<AttachmentUploadState>;
  write(chunk: AttachmentUploadChunk): Promise<AttachmentUploadState>;
  commit(spec: AttachmentUploadSpec): Promise<AttachmentUploadState>;
  abort(spec: AttachmentUploadSpec): Promise<unknown>;
};
export type AttachmentUploadContext = {
  spec?: AttachmentUploadSpec;
  source?: Blob;
  scope?: string;
  started?: boolean;
  restartRequired?: boolean;
};
export async function attachmentSha256(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** The context belongs to one selected representation and survives ordinary retries. */
export async function resumeTaskAttachment(input: {
  source: Blob; itemId: string; name: string; scope: string; context: AttachmentUploadContext;
  transport: AttachmentUploadTransport; signal?: AbortSignal;
  onProgress?: (received: number, total: number) => void;
  onPhase?: (phase: 'uploading' | 'resuming' | 'confirming') => void;
}): Promise<string> {
  const { context, transport, signal } = input;
  signal?.throwIfAborted();
  if (context.scope && context.scope !== input.scope) throw new Error('The upload belongs to a different task workspace');
  if (context.restartRequired) { context.spec = undefined; context.started = false; context.restartRequired = false; }
  if (!context.spec) {
    const bytes = await (context.source ?? input.source).arrayBuffer();
    signal?.throwIfAborted();
    context.source = new Blob([bytes], { type: input.source.type });
    context.scope = input.scope;
    context.spec = { uploadId: crypto.randomUUID(), itemId: input.itemId, name: input.name, size: bytes.byteLength, sha256: await attachmentSha256(bytes) };
  }
  const spec = context.spec;
  if (spec.itemId !== input.itemId || spec.name !== input.name) throw new Error('The upload representation changed');
  const source = context.source!;
  const validate = (state: AttachmentUploadState) => {
    if (!state || !['uploading', 'committed'].includes(state.state) || state.total !== spec.size
      || !Number.isSafeInteger(state.received) || state.received < 0 || state.received > spec.size
      || !Number.isSafeInteger(state.chunkBytes) || state.chunkBytes <= 0 || state.chunkBytes > ATTACHMENT_UPLOAD_CHUNK_BYTES
      || state.workspacePath !== `.gugu/attachments/${spec.itemId}/${spec.name}`) throw new Error('Invalid attachment upload acknowledgement');
    return state;
  };
  let aborting: Promise<unknown> | undefined;
  const abort = () => { aborting ??= transport.abort(spec).catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    const wasStarted = context.started;
    const state = validate(await (wasStarted ? transport.status(spec) : transport.begin(spec)));
    context.started = true;
    signal?.throwIfAborted();
    let confirmed = state.received;
    input.onProgress?.(confirmed, spec.size);
    if (state.state === 'committed') return state.workspacePath;
    input.onPhase?.(wasStarted && confirmed > 0 ? 'resuming' : 'uploading');
    let offset = confirmed;
    while (offset < spec.size) {
      signal?.throwIfAborted();
      const batch: Promise<void>[] = [];
      // Two ordered requests can cross one RTT together; the receiver serializes each upload.
      for (let count = 0; count < 2 && offset < spec.size; count++) {
        const start = offset, end = Math.min(spec.size, start + state.chunkBytes);
        const bytes = await source.slice(start, end).arrayBuffer();
        signal?.throwIfAborted();
        const chunkSha256 = await attachmentSha256(bytes);
        let binary = '';
        for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
        batch.push(transport.write({ ...spec, offset: start, data: btoa(binary), chunkSha256 }).then(reply => {
          const ack = validate(reply);
          if (ack.received < end) throw new Error('The remote host did not acknowledge the attachment block');
          confirmed = Math.max(confirmed, ack.received);
          if (!signal?.aborted) input.onProgress?.(confirmed, spec.size);
        }));
        offset = end;
      }
      const settled = await Promise.allSettled(batch);
      const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed) throw failed.reason;
    }
    signal?.throwIfAborted();
    input.onPhase?.('confirming');
    const committed = validate(await transport.commit(spec));
    signal?.throwIfAborted();
    if (committed.state !== 'committed' || committed.received !== spec.size) throw new Error('The attachment was not committed');
    return committed.workspacePath;
  } catch (error) {
    if (signal?.aborted) { abort(); await aborting; }
    if (['upload_lost', 'upload_expired'].includes((error as { code?: string })?.code ?? '')) context.restartRequired = true;
    throw error;
  } finally { signal?.removeEventListener('abort', abort); }
}
