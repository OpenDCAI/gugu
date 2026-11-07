import { REMOTE_WORKSPACE_CHUNK_BYTES, WORKSPACE_WRITE_FORCE } from '@gugu/session-core/session-record/contract';
import { bytesToBase64 } from '@shared/lib/base64';
import type { AppFileEntry, AppPlace } from './app-runtime-protocol';

/** One part on its way to a working copy: what `filesWriteChunk` takes, `writeWorkspaceChunk`'s fields and the place. */
export type WorkingCopyPart = { place: AppPlace; path: string; uploadId: string; offset: number; data: string; total: number; final: boolean; expectedEtag: string | null; abort?: boolean };

/** The smallest part: on a slow line one takes about a second or two, and what else the line carries gets through between parts. */
export const SMALLEST_PART_BYTES = 64 * 1024;
const PART_TOO_LONG_MS = 1500;
const PART_QUICK_MS = 500;

/**
 * How large the next part of a transfer is, from how long the last took: one call holds the line until it is through, and a
 * machine's link is closed when its heartbeats go unanswered, so a part stays about a second long on whatever line it is.
 * From the smallest, doubling while parts are quick, up to `REMOTE_WORKSPACE_CHUNK_BYTES`.
 */
export function nextPartBytes(bytes: number, tookMs: number): number {
  if (tookMs > PART_TOO_LONG_MS) return Math.max(SMALLEST_PART_BYTES, Math.floor(bytes / 2));
  if (tookMs < PART_QUICK_MS) return Math.min(REMOTE_WORKSPACE_CHUNK_BYTES, bytes * 2);
  return bytes;
}

/**
 * One version of a working copy's file, piece after piece, here or on another machine: the one reading of a whole file.
 * `begin` hears each try before its first piece (`false`: not read at all); changed while read, it is read once more from
 * the start and `changing` thrown if it moves again — pieces of two versions are neither. Aborted: `stopped`, no piece more.
 */
export async function readOneVersion(
  readPiece: (offset: number, length: number) => Promise<{ size: number; etag: string | null; data: Uint8Array<ArrayBuffer> }>,
  reader: {
    begin(size: number): boolean | void | Promise<boolean | void>;
    piece(bytes: Uint8Array<ArrayBuffer>, at: number, size: number): void | Promise<void>;
    signal?: AbortSignal;
    firstPart?: number;
    stopped(): Error;
    changing(): Error;
  },
): Promise<{ size: number; etag: string | null } | null> {
  for (let attempt = 0; ; attempt++) {
    let at = 0;
    let part = reader.firstPart ?? SMALLEST_PART_BYTES;
    let started = Date.now();
    if (reader.signal?.aborted) throw reader.stopped();
    let next = await readPiece(0, part);
    const { size, etag } = next;
    if (await reader.begin(size) === false) return null;
    for (;;) {
      if (next.data.byteLength > 0) await reader.piece(next.data, at += next.data.byteLength, size);
      if (at >= size || next.data.byteLength === 0) return { size, etag };
      if (reader.signal?.aborted) throw reader.stopped();
      part = nextPartBytes(part, Date.now() - started);
      started = Date.now();
      next = await readPiece(at, part);
      if (next.etag !== etag) break;
    }
    if (attempt > 0) throw reader.changing();
  }
}

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
    for (let offset = 0, final = false, size = SMALLEST_PART_BYTES; !final;) {
      if (options?.signal?.aborted) {
        await write({ place, path, uploadId, offset, data: '', total: blob.size, final: false, expectedEtag: null, abort: true });
        throw Object.assign(new Error('The upload was stopped'), { code: 'invalid' });
      }
      const bytes = new Uint8Array(await blob.slice(offset, offset + size).arrayBuffer());
      final = offset + bytes.length >= blob.size;
      const started = Date.now();
      const answer = await write({ place, path, uploadId, offset, data: bytesToBase64(bytes), total: blob.size, final, expectedEtag: options?.expectedEtag ?? (options?.replace ? WORKSPACE_WRITE_FORCE : null) });
      size = nextPartBytes(size, Date.now() - started);
      offset += bytes.length;
      sent += bytes.length;
      options?.onProgress?.(sent, total);
      if (final) entries.push(answer.entry!);
    }
  }
  return entries;
}
