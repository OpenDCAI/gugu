import { REMOTE_WORKSPACE_CHUNK_BYTES, WORKSPACE_WRITE_FORCE } from '@gugu/session-core/session-record/contract';
import { bytesToBase64 } from '@shared/lib/base64';
import type { AppFileEntry, AppPlace } from './app-runtime-protocol';

/** One part on its way to a working copy: what `filesWriteChunk` takes, `writeWorkspaceChunk`'s fields and the place. */
export type WorkingCopyPart = { place: AppPlace; path: string; uploadId: string; offset: number; data: string; total: number; final: boolean; expectedEtag: string | null; abort?: boolean };

/**
 * Every file going into a working copy, from a page's bytes or the person's picker, on this computer or another: part by
 * part, each written down on its machine as it comes — a file of any size, with what one call carries across machines
 * (`APP_CALL_MAX_BYTES`). One already there is `name-taken` until `replace` says so, or `expectedEtag` names the version being saved over; progress is the bytes sent of them all.
 */
export async function uploadInParts(
  write: (part: WorkingCopyPart) => Promise<{ received: number; entry?: AppFileEntry }>,
  place: AppPlace,
  files: readonly { name: string; blob: Blob }[],
  folder: string | undefined,
  options?: { replace?: boolean; expectedEtag?: string | null; onProgress?: (sent: number, total: number) => void; signal?: AbortSignal },
): Promise<AppFileEntry[]> {
  const total = files.reduce((sum, { blob }) => sum + blob.size, 0);
  const entries: AppFileEntry[] = [];
  let sent = 0;
  for (const { name, blob } of files) {
    const path = folder ? `${folder.replace(/^\/+|\/+$/g, '')}/${name}` : name;
    const uploadId = crypto.randomUUID();
    for (let offset = 0, final = false; !final;) {
      if (options?.signal?.aborted) {
        await write({ place, path, uploadId, offset, data: '', total: blob.size, final: false, expectedEtag: null, abort: true });
        throw Object.assign(new Error('The upload was stopped'), { code: 'invalid' });
      }
      const bytes = new Uint8Array(await blob.slice(offset, offset + REMOTE_WORKSPACE_CHUNK_BYTES).arrayBuffer());
      final = offset + bytes.length >= blob.size;
      const answer = await write({ place, path, uploadId, offset, data: bytesToBase64(bytes), total: blob.size, final, expectedEtag: options?.expectedEtag ?? (options?.replace ? WORKSPACE_WRITE_FORCE : null) });
      offset += bytes.length;
      sent += bytes.length;
      options?.onProgress?.(sent, total);
      if (final) entries.push(answer.entry!);
    }
  }
  return entries;
}
