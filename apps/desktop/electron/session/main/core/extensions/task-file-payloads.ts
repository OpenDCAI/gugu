import { APP_FILE_MAX_BYTES, type AppFileVersionContent } from '@shared/extensions/app-runtime-protocol';
import { taskPageFileRefs, type TaskPageFilePayload } from '@shared/extensions/task-page-files';
import type { BridgeCaller } from './extension-bridge';
import type { DesktopFilePage } from './app-files';

export type TaskFileMetadata = { id: string; chat: string; name: string; contentType: string; version: number; size: number | null };
export type TaskFileSource = {
  metadata(page: DesktopFilePage, ref: { id: string; chat: string }): Promise<TaskFileMetadata>;
  version(page: DesktopFilePage, ref: { id: string; chat: string }, version: number): Promise<AppFileVersionContent>;
};
const refuse = (code: 'denied' | 'invalid' | 'too-large' | 'content-changed' | 'unavailable', message: string) => Object.assign(new Error(message), { code });

/** Stop waiting promptly; late service replies are observed but never published to the App. */
function cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) reject(signal.reason); else resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

/** Reads only files the host handed this exact live call. Broader App file grants never substitute for that proof. */
export async function readTaskFilePayloads(caller: BridgeCaller, refs: unknown, signal: AbortSignal,
  source: TaskFileSource): Promise<TaskPageFilePayload[]> {
  signal.throwIfAborted();
  if (caller.kind !== 'program' || !caller.callingSession || !caller.callingAgent || !caller.signal) {
    throw refuse('denied', 'File payloads need a current agent task call and its handed file cards');
  }
  const given = taskPageFileRefs(refs);
  const authorized: { page: DesktopFilePage; ref: { id: string; chat: string }; expectedVersion?: number }[] = [];
  for (const file of given) {
    signal.throwIfAborted();
    const page = await cancellable(Promise.resolve(caller.filePage({ ref: { id: file.itemId } })), signal);
    const handed = page.handed;
    if (!handed || !('chat' in handed) || typeof handed.chat !== 'string' || handed.id.toLowerCase() !== file.itemId.toLowerCase()
      || page.asAgent !== caller.callingAgent || page.pageId !== caller.pageId || page.extensionId !== caller.extensionId
      || !page.callId || page.signal !== caller.signal) throw refuse('denied', 'This file card was not handed to this call');
    const versions = page.handedVersions;
    if (versions?.some(version => !Number.isSafeInteger(version) || version < 1)
      || versions?.length && file.expectedVersion !== undefined && !versions.includes(file.expectedVersion)) {
      throw refuse('invalid', 'The upload version was not the version of the handed file card');
    }
    if (versions && versions.length > 1 && file.expectedVersion === undefined) throw refuse('invalid', 'Choose one of the handed file card versions');
    authorized.push({ page: { ...page, signal }, ref: { id: handed.id, chat: handed.chat }, expectedVersion: file.expectedVersion ?? versions?.[0] });
  }
  // All per-call grants pass before the first metadata/content request. All sizes pass before any content read.
  const ready: { page: DesktopFilePage; ref: { id: string; chat: string }; metadata: TaskFileMetadata }[] = [];
  let total = 0;
  for (const file of authorized) {
    signal.throwIfAborted();
    const metadata = await cancellable(source.metadata(file.page, file.ref), signal);
    if (metadata.id.toLowerCase() !== file.ref.id.toLowerCase() || metadata.chat !== file.ref.chat) throw refuse('denied', 'The file reference changed scope');
    if (!Number.isSafeInteger(metadata.version) || metadata.version < 1
      || file.expectedVersion !== undefined && metadata.version !== file.expectedVersion) throw refuse('content-changed', 'The file card version changed');
    if (metadata.size === null || !Number.isSafeInteger(metadata.size) || metadata.size < 0) throw refuse('unavailable', 'The file has no verified upload size');
    total += metadata.size;
    if (total > APP_FILE_MAX_BYTES) throw refuse('too-large', 'File payloads exceed the 25 MiB combined limit');
    ready.push({ ...file, metadata });
  }
  const payloads: TaskPageFilePayload[] = [];
  let actual = 0;
  for (const file of ready) {
    signal.throwIfAborted();
    const content = await cancellable(source.version(file.page, file.ref, file.metadata.version), signal);
    if (content.n !== file.metadata.version) throw refuse('content-changed', 'The file snapshot version changed');
    const size = 'text' in content ? Buffer.byteLength(content.text, 'utf8') : content.bytes.byteLength;
    actual += size;
    if (actual > APP_FILE_MAX_BYTES) throw refuse('too-large', 'File payloads exceed the 25 MiB combined limit');
    if (size !== file.metadata.size) throw refuse('content-changed', 'The file snapshot size changed');
    const bytes = 'text' in content ? new TextEncoder().encode(content.text).buffer : content.bytes.slice(0);
    payloads.push({ name: file.metadata.name, mimeType: file.metadata.contentType, bytes, version: content.n });
  }
  // Recheck the file door before publishing the batch, including loss of membership during a download.
  for (const file of ready) {
    const current = await cancellable(source.metadata(file.page, file.ref), signal);
    for (const key of ['id', 'chat', 'name', 'contentType', 'version', 'size'] as const) {
      if (current[key] !== file.metadata[key]) throw refuse('content-changed', 'The file card changed while preparing its payload');
    }
  }
  signal.throwIfAborted();
  return payloads;
}

/** Existing file authority and verified snapshot transport; no filesystem path or driver in this adapter. */
export async function taskFilePayloadSource(): Promise<TaskFileSource> {
  const files = await import('./app-files');
  return {
    metadata: (page, ref) => files.appFilePayloadMetadata(page, { ref }),
    version: (page, ref, n) => files.readAppFileVersion(page, { ref, n }),
  };
}
