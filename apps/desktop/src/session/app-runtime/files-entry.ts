import { fileSearchOf, folderOf, placeOf, type AppFileEntry, type AppPlace } from '@shared/extensions/app-runtime-protocol';
import { guguError, refOf, type GuguHost } from './host';
import { askingMain, fileKey, openFiles, OpenFile } from './open-file';
import { countsOf } from './check-counts';

export { bindText } from './text-binding';

/**
 * `/_gugu/<ver>/files.js` — loaded the first time a page touches `gugu.files`. Everything
 * that knows about Yjs and the provider is behind this import, so an App that never opens
 * a file never pays for it.
 */

/** item → the replica on its way to its first sync, shared by every `open` of it meanwhile. */
const opening = new Map<string, { file: OpenFile; ready: Promise<void> }>();

/** How long `files.open(…)` waits for the open file before it says so (摩擦单 F28: it must never hang). */
const OPEN_DEADLINE_MS = 10_000;

/** The open file's answer, or `file-unavailable` naming the step it stopped at. */
function withinDeadline(openFile: OpenFile, connecting: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(guguError('file-unavailable', `${openFile.entry.name}: the file service did not answer within ${OPEN_DEADLINE_MS / 1000} s (waiting for: ${openFile.stage})`));
    }, OPEN_DEADLINE_MS);
  });
  return Promise.race([connecting, late]).finally(() => clearTimeout(timer));
}

/**
 * Every call gets a handle of its own on the page's one replica of the file, concurrent calls and later
 * ones alike; `close()` lets go of one handle, and the replica goes with the last (摩擦单 F46: two opens
 * shared one object, and the first `close()` took the file from under the second).
 */
export async function openFile(host: GuguHost, file: unknown, options?: { readOnly?: boolean }): Promise<object> {
  // The check's page (摩擦单 F69) says when its opens settle: the check reads the page only after (F5).
  const counts = countsOf(host);
  counts?.opened();
  try {
    return await openNow(host, file, options);
  } finally {
    counts?.openSettled();
  }
}

async function openNow(host: GuguHost, file: unknown, options?: { readOnly?: boolean }): Promise<object> {
  const readOnly = options?.readOnly === true;
  // Counted until its answer has taken its handle: a replica let go of meanwhile waits for it (摩擦单 F115).
  const answered = askingMain();
  let handle: object;
  let ready: Promise<void>;
  try {
    const opened = await host.appFiles.open({ ref: refOf(file), ...(readOnly ? { readOnly: true } : {}) });
    if (opened.bytes) return storedFile(opened.entry, opened.bytes);
    const id = fileKey(opened.entry);
    const existing = openFiles.get(id);
    if (existing && existing.status !== 'gone') return existing.handle();
    let pending = opening.get(id);
    if (!pending) {
      const openFile = new OpenFile(host, opened);
      const ready = withinDeadline(openFile, openFile.connect())
        .then(
          () => {
            openFiles.set(id, openFile);
          },
          (error: unknown) => {
            // The half-made replica goes.
            openFile.close();
            throw error;
          },
        )
        .finally(() => opening.delete(id));
      pending = { file: openFile, ready };
      opening.set(id, pending);
    }
    // Taken now, not once it is ready: a caller closing its handle meanwhile must not take the file from this one.
    handle = pending.file.handle();
    ready = pending.ready;
  } finally {
    answered();
  }
  await ready;
  return handle;
}

/**
 * A stored file — an image, a clip, a sound: read-only, nothing synced. `blob()` is what `<img>`, `<video>` and `<audio>`
 * take through `URL.createObjectURL` (the page's CSP admits `blob:`).
 */
function storedFile(entry: AppFileEntry, bytes: ArrayBuffer): object {
  const blob = new Blob([bytes], { type: entry.contentType });
  return Object.freeze({ entry: { ...entry }, type: 'binary', readOnly: true, blob: async () => blob, close: () => undefined });
}

/** A place as the page passed it, checked: what is not one throws `invalid`, as a coded Error. */
function where(place: unknown): AppPlace {
  try {
    return placeOf(place);
  } catch (error) {
    throw guguError('invalid', error instanceof Error ? error.message : String(error));
  }
}

/** The folder a call names (子文件夹), checked: what is not one throws `invalid`. */
function folderNamed(value: unknown): string | undefined {
  return checked(() => folderOf(value));
}

/** `files.list({ chat, folder })`: `folder` (子文件夹) lists only what is directly in it; without it, every file. */
export function listEntries(host: GuguHost, place: unknown) {
  const folder = folderNamed((place as { folder?: unknown } | null)?.folder);
  return host.appFiles.list({ place: where(place), ...(folder === undefined ? {} : { folder }) });
}

/** `files.search({ query, suffixes, limit })`, checked here: what is not one throws `invalid`. */
export function searchEntries(host: GuguHost, options: unknown) {
  return host.appFiles.search(checked(() => fileSearchOf(options)));
}

/** `files.recent({ limit })`: the files this person opened last, newest first. */
export function recentEntries(host: GuguHost, options: unknown) {
  const { limit } = checked(() => fileSearchOf(options));
  return host.appFiles.recent(limit === undefined ? {} : { limit });
}

/** What a call names, read: what is not what it should be throws `invalid`. */
function checked<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw guguError('invalid', error instanceof Error ? error.message : String(error));
  }
}

/** `files.create({ chat | session, name, folder }, content)`: a new file, named where it goes (`folder`: 子文件夹). */
export function createFile(host: GuguHost, target: unknown, content: string | object, options?: { contentType?: string; sourceMessageIds?: string[] }) {
  const place = where(target);
  const name = (target as { name?: unknown }).name;
  const folder = folderNamed((target as { folder?: unknown }).folder);
  if (typeof name !== 'string' || !name.trim()) throw guguError('invalid', 'A file needs a name: files.create({ chat | session, name }, content)');
  const isJson = typeof content !== 'string';
  if (isJson && (content === null || Array.isArray(content))) {
    throw guguError('invalid', 'A JSON file must hold an object at the top (its root is shared per key)');
  }
  return host.appFiles.create({
    place,
    name,
    content: isJson ? JSON.stringify(content, null, 2) : content,
    ...(options?.contentType ? { contentType: options.contentType } : isJson ? { contentType: 'application/json' } : {}),
    sourceMessageIds: options?.sourceMessageIds,
    ...(folder === undefined ? {} : { folder }),
  });
}

/** 子文件夹 `files.mkdir({ chat, path })`: a chat's folder at that path, made all the way down — one already there as it is. */
export function makeFolder(host: GuguHost, target: unknown) {
  const place = where(target);
  const path = (target as { path?: unknown }).path;
  if (typeof path !== 'string' || !path.trim()) throw guguError('invalid', "A folder needs its path: files.mkdir({ chat, path: '合同/2026' })");
  return host.appFiles.mkdir({ place, path });
}

/** 子文件夹 `files.move(file, { folder, name })`: into another folder ('' the top), renamed too when `name` is given. */
export function moveFile(host: GuguHost, file: unknown, to: unknown) {
  const target = (to ?? {}) as { folder?: unknown; name?: unknown };
  const folder = folderNamed(target.folder);
  if (target.name !== undefined && (typeof target.name !== 'string' || !target.name.trim())) throw guguError('invalid', 'A file needs a name');
  if (folder === undefined && target.name === undefined) throw guguError('invalid', 'files.move(file, { folder, name }): say where it goes, its new name, or both');
  return host.appFiles.move({ ref: refOf(file), ...(folder === undefined ? {} : { folder }), ...(target.name === undefined ? {} : { name: target.name as string }) });
}

export function removeFile(host: GuguHost, file: unknown) {
  return host.appFiles.remove({ ref: refOf(file) });
}

export function renameFile(host: GuguHost, file: unknown, name: string) {
  if (typeof name !== 'string' || !name.trim()) throw guguError('invalid', 'A file needs a name');
  return host.appFiles.rename({ ref: refOf(file), name });
}
