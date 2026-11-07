import { requireAgentFileAccess, requireAgentFileTreeAccess } from '@gugu/core/local/state/agentFileBoundary';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Hocuspocus } from '@hocuspocus/server';
import { applyEdits, modify, type FormattingOptions } from 'jsonc-parser';
import * as Y from 'yjs';
import { applyJson, buildDoc, InvalidJson, isJson, parseJsonObject, readText, sameContent, spliceText } from '@gugu/files-core/content';
import { createOpenFiles } from '@gugu/files-core/open-files';
import { colorFor } from '@gugu/files-core/presence';
import { WORKSPACE_TEXT_MAX_BYTES, opensAsStoredText, workspaceStoredText, workspaceUploadKind } from '@gugu/core/shared/workspaceUpload.mjs';
import { AppFileError, contentTypeOf, requireHandedOr, tooLargeError, type FilesPlatform } from '@shared/extensions/app-files-core';
import {
  APP_FILE_MAX_BYTES,
  fileSuffixOf,
  fileTypeOf,
  type AppFileEntry,
  type AppFileOpened,
  type AppFileUpload,
  type WorkspaceFileRef,
  type WorkspacePlace,
  placeKey,
} from '@shared/extensions/app-runtime-protocol';
import { LOCAL_DOC_PREFIX, type Grant, type SocketEvents, type SocketHandle } from '@shared/extensions/file-sync-core';
import type { FileChangeUpdate } from '@gugu/session-core/files';
import { resolvesInside } from './path-containment';

/**
 * `gugu.files` on a task's working copy: a file service in main, over the disk (App platform design L2, task files
 * local service, approved 09-30). A page cannot tell it
 * from the group's — the same `gugu.files.open`, the same handle, the same merge rules: both run `@gugu/files-core`,
 * and this file only says where a file loads from, where it is written, and who may open it.
 *
 * - **Hocuspocus in this process**: no port, no network, no credential. The relay hands it the documents whose name
 *   starts with `wc:` (`connect`), on one in-process connection.
 * - **The disk is the truth; no Yjs state is kept.** When the last page closes a file it is written and unloaded; the
 *   next open builds it from the disk again, under the next generation (`wc:<key>@<gen>`). A page still holding the
 *   old one is told `stale-epoch:<gen>` and reopens — replaying its old replica into a rebuilt document would repeat
 *   the whole text (E4).
 * - **A change on the disk** (the agent's `edit`, an editor, git) is merged three-way: from what the disk last held
 *   (`base`, a Yjs state the open document descends from) to what it holds now, applied as a concurrent change — so an
 *   edit in a page that was not written yet survives it, and the disk's change reaches every page live. Text by
 *   characters, JSON by keys (the same diff as the agent's `edit(old, new)` in a group).
 * - **Writing** (debounced 1 s, at most 5 s, and when the last page closes): what is on the disk is merged first, so an
 *   outside write is never lost; then written atomically (a temporary file beside it, renamed over it), keeping its
 *   line endings, BOM and mode; JSON has only what changed edited into its text (F97). Nothing changed → nothing written.
 * - **The disk is heard from the working copy's change stream** — the one the session page's file tree and search index read
 *   (`watchChanges`, workspace-factory), not a watch of our own: a change at an open file's path, or at a folder on it
 *   (a branch switch takes folders too), is read with the batch it comes in (`heard`). What that stream leaves out (the
 *   folders the search index skips) is not heard: it reaches the pages at the next write, which merges the disk first. A file gone for half a second closes its connections as `deleted`.
 * - **A deleted file can come back** (`git checkout -- f`, an undo, a branch switch and back): while a page still holds
 *   it, a file there again is heard the same way, the page is told (`awaitReturn`) and reopens it under the
 *   next generation, built from the disk — its path is its identity here, unlike a group's item (摩擦单 F92). What a
 *   page changed that was not written yet (the 1–5 s above) went with the file, as an editor's unsaved changes do.
 */

/** Who the pages are: this machine's signed-in person, as the group's file service would stamp them. */
export interface LocalActor {
  /** `user:<uuid>`, as `AppFileOpened.self.userId`. */
  userId: string;
  name: string;
}

interface Registered {
  /** A stable id for this file in this process: the document's name is `wc:<key>@<gen>`. */
  key: string;
  /** Its real path (a link resolved), and relative to the working copy it was opened from (POSIX separators). */
  abs: string;
  rel: string;
  /** The working copy's real path (the one it was opened in). */
  root: string;
  contentType: string;
  gen: number;
  /** Who opened it last: presence and `self` are stamped with it (one person per machine). */
  actor: LocalActor;
  /** Pages waiting for it to come back after it was deleted. */
  waiters: Set<() => void>;
}

interface DiskShape {
  eol: '\n' | '\r\n';
  bom: boolean;
  /** JSON only: how it is indented ('' = on one line), for what a change adds. */
  indent: string;
  mode: number;
}

interface Loaded {
  reg: Registered;
  document: Y.Doc;
  shape: DiskShape;
  /** The hash of the bytes the disk held when we last read or wrote it. */
  diskHash: string;
  /** Those bytes as text (\n line endings, no BOM): what a JSON write edits (F97). */
  diskText: string;
  /** Those bytes as a Yjs state the open document descends from: the base of the three-way merge. */
  base: Uint8Array;
  goneCheck: ReturnType<typeof setTimeout> | null;
  gone: boolean;
}

const MAX_BYTES = WORKSPACE_TEXT_MAX_BYTES;
/** A file missing for this long is gone, not being replaced. */
const GONE_AFTER_MS = 500;
/**
 * No idle timeout: the connection is a function call away, and a page that goes is seen going by the relay. (The
 * Hocuspocus check runs on this interval; setInterval tops out at 2^31-1 ms.)
 */
const CONNECTION_TIMEOUT_MS = 24 * 3600_000;

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const code = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isFileAt = (abs: string) => fs.statSync(abs, { throwIfNoEntry: false })?.isFile() === true;

/** Bytes on the disk → the text a document holds (\n line endings, no BOM) and how to write it back. */
function fromDisk(raw: Uint8Array, contentType: string, mode: number): { text: string; shape: DiskShape } {
  // ignoreBOM: keep it in the decoded text (the default drops it), so it is seen and written back.
  const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  const bom = decoded.startsWith('﻿');
  const body = bom ? decoded.slice(1) : decoded;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const text = eol === '\r\n' ? body.replace(/\r\n/g, '\n') : body;
  const json = isJson(contentType);
  const indent = json ? (/\n([ \t]+)\S/.exec(text)?.[1] ?? (text.trimEnd().includes('\n') ? '  ' : '')) : '';
  return { text, shape: { eol, bom, indent, mode } };
}

/** What a new file looks like on the disk. */
const FRESH_MODE = 0o644;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A JSON file written back the way the disk has it (F97): what changed is edited into the text last read or written —
 * its indentation, key order, line breaks and inline arrays stay, and `git diff` shows only the lines that changed. A
 * map is gone into key by key; an array of the same length item by item; any other change is one value, written anew.
 */
function patchJson(was: string, next: Record<string, unknown>, indent: string): string {
  const formattingOptions: FormattingOptions = {
    insertSpaces: !indent.startsWith('\t'),
    tabSize: indent.startsWith('\t') ? 1 : indent.length || 2,
    eol: '\n',
  };
  let text = was;
  const walk = (at: (string | number)[], before: unknown, after: unknown): void => {
    if (isRecord(before) && isRecord(after)) {
      for (const key of Object.keys(before)) {
        if (!(key in after)) text = applyEdits(text, modify(text, [...at, key], undefined, { formattingOptions }));
      }
      for (const [key, value] of Object.entries(after)) walk([...at, key], before[key], value);
      return;
    }
    if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
      after.forEach((value, i) => walk([...at, i], before[i], value));
      return;
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) text = applyEdits(text, modify(text, at, after, { formattingOptions }));
  };
  walk([], JSON.parse(was), next);
  return text;
}

/** A document → the text to write (\n line endings, no BOM), shaped like the file's text last read or written. */
function render(document: Y.Doc, contentType: string, shape: DiskShape, diskText: string): string {
  return isJson(contentType)
    ? patchJson(diskText, document.getMap('root').toJSON() as Record<string, unknown>, shape.indent)
    : document.getText('content').toString();
}

/** That text as the bytes on the disk: the file's line endings and BOM. */
function bytesOf(text: string, shape: DiskShape): Buffer {
  return Buffer.from((shape.bom ? '﻿' : '') + (shape.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text), 'utf8');
}

/** Where a file is: its real path, its working copy's real path, and its path in it (POSIX). Read live: a rename moves it. */
export interface WatchedFile {
  abs: string;
  root: string;
  rel: string;
}

/** The content type a working-copy file goes by: a name the table does not know is text (a working copy is mostly source). */
function localContentType(name: string): string {
  const named = contentTypeOf(name);
  return named === 'application/octet-stream' ? 'text/plain' : named;
}

/** Whether a file of the working copy is a document to open — the one rule a group upload follows too (F19). */
const documentKind = (name: string, raw: Uint8Array) => workspaceUploadKind(name, localContentType(name), raw);

/**
 * A working copy's file (or folder: no `stat` read) as `gugu.files` shows it — the same shape as a chat file's. Its id is
 * its path; it names its folder (`place`).
 */
/** A folder of a working copy, as a list names it. */
export function workingCopyFolder(place: WorkspacePlace, rel: string): AppFileEntry {
  return { ...workingCopyEntry(place, rel, null, 'inode/directory'), type: 'folder', suffix: '' };
}

export function workingCopyEntry(place: WorkspacePlace, rel: string, stat: fs.Stats | null, contentType = localContentType(rel)): AppFileEntry {
  const name = path.posix.basename(rel);
  const kind = /^text\//.test(contentType) || isJson(contentType) ? 'document' : 'file';
  return {
    id: rel,
    ...place,
    name,
    savedName: name,
    contentType,
    type: fileTypeOf(kind, contentType),
    parentId: null,
    path: rel,
    systemRole: null,
    // A working copy's file is named by its path: its suffix is the name's, never the text/plain a name the table does not know is read as.
    suffix: fileSuffixOf({ name, contentType: contentTypeOf(name) }),
    displayName: name,
    claimedBy: null,
    appState: false,
    size: stat?.size ?? null,
    version: null,
    // A file system that keeps no creation time says 0: unknown, not 1970.
    createdAt: stat && stat.birthtimeMs > 0 ? stat.birthtime.toISOString() : null,
    updatedAt: stat?.mtime.toISOString() ?? null,
    createdBy: null,
    updatedBy: null,
    sourceMessageIds: [],
  };
}

export function createLocalFileService(options: { warn: (message: string, data?: Record<string, unknown>) => void }) {
  const { warn } = options;
  const openFiles = createOpenFiles<{ contentType: string }>({
    maxBytes: MAX_BYTES,
    // One person types here; these only stop an App that runs away — it would hold up main, which all of gugu shares.
    limits: {
      rateUpdates: { perSecond: 500, burst: 5000 },
      rateBytes: { perSecond: 2560 * 1024, burst: 80 * 1024 * 1024 },
      rateAwareness: { perSecond: 200, burst: 600 },
    },
    log: { warn: (message, fields) => warn(`Local files: ${message}`, fields as Record<string, unknown>), info: () => undefined },
    // What files-core counts as it goes; nobody here reads it.
    stats: { rateLimited: 0, tooLarge: 0, presenceCoalesced: 0, presenceFlushed: 0, concurrentMerges: { create: 0, lateWrite: 0 } },
  });
  const byKey = new Map<string, Registered>();
  const byPath = new Map<string, Registered>();
  const loaded = new Map<string, Loaded>();

  const docNameOf = (reg: Registered) => `${LOCAL_DOC_PREFIX}${reg.key}@${reg.gen}`;
  const parse = (docName: string) => {
    const m = /^wc:([0-9a-f]{24})@(\d+)$/.exec(docName);
    return m ? { reg: byKey.get(m[1]!), gen: Number(m[2]) } : null;
  };
  const refuse = (reason: string) => Object.assign(new Error(reason), { reason });
  const loadedAt = (abs: string) => [...loaded.values()].find((l) => l.reg.abs === abs && !l.gone);

  /**
   * Merge what the disk holds now into the open document, three-way from `base`: the disk's text as a change made at
   * `base`, concurrent with everything since — text by characters (`spliceText`), JSON by keys. `missing`: the file is
   * not there (maybe being replaced); `unmergeable`: it cannot be read as this kind of file, or is over the size of an open
   * file (L11 R20) — left alone, nothing written over it.
   */
  async function pullDisk(l: Loaded): Promise<'same' | 'merged' | 'missing' | 'unmergeable'> {
    try {
      await requireAgentFileTreeAccess(l.reg.root);
      await requireAgentFileAccess(l.reg.abs);
    } catch {
      markGone(l);
      return 'unmergeable';
    }
    let raw: Buffer;
    let mode: number;
    try {
      raw = fs.readFileSync(l.reg.abs);
      mode = fs.statSync(l.reg.abs).mode;
    } catch (error) {
      if (code(error) === 'ENOENT') return 'missing';
      warn('Local files: a changed file could not be read', { file: l.reg.rel, message: messageOf(error) });
      return 'unmergeable';
    }
    const hash = sha(raw);
    if (hash === l.diskHash) return 'same';
    let disk;
    const fork = new Y.Doc();
    try {
      if (raw.byteLength > MAX_BYTES) throw new Error(`over the ${MAX_BYTES} bytes of an open file`);
      disk = fromDisk(raw, l.reg.contentType, mode);
      const text = disk.text;
      Y.applyUpdate(fork, l.base);
      const before = Y.encodeStateVector(fork);
      if (isJson(l.reg.contentType)) fork.transact(() => applyJson(fork.getMap('root'), parseJsonObject(text)));
      else spliceText(fork.getText('content'), text);
      Y.applyUpdate(l.document, Y.encodeStateAsUpdate(fork, before));
      l.base = Y.encodeStateAsUpdate(fork);
    } catch (error) {
      warn('Local files: the file on disk cannot be merged; left as it is, nothing written over it', { file: l.reg.rel, message: messageOf(error) });
      return 'unmergeable';
    } finally {
      fork.destroy();
    }
    l.diskHash = hash;
    l.diskText = disk.text;
    l.shape = disk.shape;
    return 'merged';
  }

  /**
   * Write the open document to the disk: what the disk holds is merged in first (an outside write is never written
   * over), then the bytes go to a temporary file beside it, renamed over it. Nothing changed → nothing written.
   */
  async function writeOut(documentName: string, l: Loaded): Promise<void> {
    const info = openFiles.docs.get(documentName)!;
    const pulled = await pullDisk(l);
    if (pulled === 'missing' || pulled === 'unmergeable') {
      // Not written over: the next change on the disk (a watch) or in a page brings the write back.
      info.dirty = true;
      if (pulled === 'missing') suspectGone(l);
      return;
    }
    // What is written and the state it is written from, at one moment: the next merge's base.
    const snap = openFiles.snapshot(documentName, l.document);
    const text = render(l.document, l.reg.contentType, l.shape, l.diskText);
    const bytes = bytesOf(text, l.shape);
    const hash = sha(bytes);
    if (hash !== l.diskHash) {
      const tmp = path.join(path.dirname(l.reg.abs), `.${path.basename(l.reg.abs)}.${randomBytes(4).toString('hex')}.gugu-tmp`);
      try {
        fs.writeFileSync(tmp, bytes, { mode: l.shape.mode & 0o7777 });
        // Checked again just before the rename: a write that landed while we composed ours is merged, not replaced.
        if (sha(fs.readFileSync(l.reg.abs)) !== l.diskHash) {
          fs.rmSync(tmp, { force: true });
          info.dirty = true;
          await pullDisk(l);
          return;
        }
        fs.renameSync(tmp, l.reg.abs);
      } catch (error) {
        fs.rmSync(tmp, { force: true });
        info.dirty = true;
        if (code(error) === 'ENOENT') suspectGone(l);
        else warn('Local files: could not write a file; the change stays open in memory', { file: l.reg.rel, message: messageOf(error) });
        return;
      }
      l.diskHash = hash;
      l.diskText = text;
    }
    l.base = snap.state;
    openFiles.stored(documentName, snap);
  }

  /**
   * Every page's connection to it closes as `deleted` (the relay takes the grant back and tells the page `gone`). The
   * next open is a new generation from now, not from when this document is unloaded: the file may be back before that.
   */
  function markGone(l: Loaded): void {
    if (l.gone) return;
    l.gone = true;
    l.reg.gen += 1;
    for (const connection of (l.document as unknown as { getConnections(): { close(event: object): void }[] }).getConnections()) {
      connection.close({ code: 4410, reason: 'deleted' });
    }
  }

  function suspectGone(l: Loaded): void {
    if (l.goneCheck || l.gone) return;
    l.goneCheck = setTimeout(() => {
      l.goneCheck = null;
      if (fs.existsSync(l.reg.abs)) void pullDisk(l).catch(() => markGone(l));
      else markGone(l);
    }, GONE_AFTER_MS);
  }

  /** A file's path changed on the disk (or may have): its open document takes it in; pages waiting for it to come back are told. */
  async function look(reg: Registered): Promise<void> {
    const l = loadedAt(reg.abs);
    if (l && await pullDisk(l) === 'missing') suspectGone(l);
    if (reg.waiters.size === 0 || !isFileAt(reg.abs)) return;
    const waiters = [...reg.waiters];
    reg.waiters.clear();
    for (const back of waiters) back();
  }

  const hocuspocus = new Hocuspocus({
    name: 'gugu-local-files',
    quiet: true,
    timeout: CONNECTION_TIMEOUT_MS,
    debounce: 1000,
    maxDebounce: 5000,
    unloadImmediately: true,

    async onAuthenticate({ documentName, context }) {
      const parsed = parse(documentName);
      if (!parsed?.reg) throw refuse('not-found');
      if (parsed.reg.gen !== parsed.gen) throw refuse(`stale-epoch:${parsed.reg.gen}`);
      const actorId = parsed.reg.actor.userId.replace(/^user:/, '');
      return { ...context, actorId, actorName: parsed.reg.actor.name, color: colorFor(actorId) };
    },

    async onLoadDocument({ documentName, document }) {
      const reg = parse(documentName)?.reg;
      if (!reg) throw refuse('not-found');
      await requireAgentFileTreeAccess(reg.root);
      await requireAgentFileAccess(reg.abs);
      let raw: Buffer;
      let mode: number;
      try {
        raw = fs.readFileSync(reg.abs);
        mode = fs.statSync(reg.abs).mode;
      } catch (error) {
        throw refuse(code(error) === 'ENOENT' ? 'not-found' : 'unavailable');
      }
      if (raw.byteLength > MAX_BYTES) throw refuse('too-large');
      let disk;
      let built;
      try {
        disk = fromDisk(raw, reg.contentType, mode);
        built = buildDoc(reg.contentType, disk.text);
      } catch (error) {
        throw refuse(error instanceof InvalidJson ? 'invalid-json' : 'not-text');
      }
      const base = Y.encodeStateAsUpdate(built);
      built.destroy();
      Y.applyUpdate(document, base);
      openFiles.attach(document, documentName, { contentType: reg.contentType });
      const l: Loaded = { reg, document, shape: disk.shape, diskHash: sha(raw), diskText: disk.text, base, goneCheck: null, gone: false };
      loaded.set(documentName, l);
      // The file held a {"$text"} mark (made live text now): the disk gets the plain projection at once, as a group
      // file's text does — the mark is never read back. Anything else is left exactly as it was until a change.
      if (!sameContent(reg.contentType, readText(document, reg.contentType), disk.text)) await writeOut(documentName, l);
    },

    // Rate and size limits, presence stamps, `self`, the change mark: the shared package's, as in the group service.
    ...openFiles.hooks,

    async onStoreDocument({ documentName }) {
      const info = openFiles.docs.get(documentName);
      const l = loaded.get(documentName);
      if (!info || !l || l.gone || !info.dirty) return;
      info.dirty = false;
      await writeOut(documentName, l);
    },

    async afterUnloadDocument({ documentName }) {
      const l = loaded.get(documentName);
      loaded.delete(documentName);
      openFiles.docs.delete(documentName);
      if (!l) return;
      if (l.goneCheck) clearTimeout(l.goneCheck);
      // Built from the disk at the next open: a new generation (a deleted one moved on when it went).
      if (!l.gone) l.reg.gen += 1;
    },
  });

  return {
    /** The relay's local connection: one in-process "socket", its other end handed to Hocuspocus. */
    connect(events: SocketEvents): SocketHandle {
      let open = true;
      const socket = {
        readyState: 1,
        send: (data: Uint8Array) => {
          if (open) queueMicrotask(() => events.message(new Uint8Array(data)));
        },
        close: (closeCode?: number, reason?: string) => {
          if (!open) return;
          end();
          queueMicrotask(() => events.close(closeCode ?? 1000, reason ?? ''));
        },
      };
      function end() {
        open = false;
        socket.readyState = 3;
      }
      const connection = hocuspocus.handleConnection(socket as never, { headers: {}, url: '/' } as never, {});
      queueMicrotask(() => {
        if (open) events.open();
      });
      return {
        send: (frame) => {
          if (open) connection.handleMessage(frame);
        },
        close: (closeCode, reason) => {
          if (!open) return;
          end();
          connection.handleClose({ code: closeCode, reason });
        },
        ping: () => false,
        terminate: () => {
          if (!open) return;
          end();
          connection.handleClose({ code: 1006, reason: 'terminated' });
        },
      };
    },

    /** The document name a page is granted for this file: the same one while it stays open, a new one after. */
    register(file: WatchedFile, contentType: string, actor: LocalActor): string {
      const { abs, rel } = file;
      let reg = byPath.get(abs);
      if (!reg) {
        // Real, as `abs` is (macOS's /tmp is /private/tmp), as the change stream speaks.
        const root = fs.realpathSync.native(file.root);
        reg = { key: randomBytes(12).toString('hex'), abs, rel, root, contentType, gen: 1, actor, waiters: new Set() };
        byPath.set(abs, reg);
        byKey.set(reg.key, reg);
      }
      reg.actor = actor;
      return docNameOf(reg);
    },

    /** Renamed here: open pages keep their document, now written to the new path. */
    renamed(fromAbs: string, toAbs: string, toRel: string): void {
      for (const [abs, reg] of [...byPath]) {
        if (abs !== fromAbs && !abs.startsWith(fromAbs + path.sep)) continue;
        const below = abs.slice(fromAbs.length);
        byPath.delete(abs);
        reg.abs = toAbs + below;
        reg.rel = toRel + below.split(path.sep).join('/');
        byPath.set(reg.abs, reg);
      }
    },

    /** Deleted here: its pages are told now, not half a second later. */
    removed(gone: string): void {
      for (const abs of [...byPath.keys()]) {
        if (abs !== gone && !abs.startsWith(gone + path.sep)) continue;
        const l = loadedAt(abs);
        if (l) markGone(l);
      }
    },

    /**
     * A page's file went as `deleted`: `back` is called once when a file is at its path again, and the page reopens it
     * (the next generation, built from the disk). The answer stops waiting: the page closed the file, or went.
     */
    awaitReturn(docName: string, back: () => void): () => void {
      const reg = parse(docName)?.reg;
      if (!reg) return () => undefined;
      const waiter = () => back();
      reg.waiters.add(waiter);
      // Back already, before anyone waited (the relay hears `deleted` a moment after it went).
      setTimeout(() => { void look(reg).catch(() => warn('Local files: protected file is unavailable')); }, 0);
      return () => {
        reg.waiters.delete(waiter);
      };
    },

    /**
     * The working copy's change stream (`watchChanges`; main hears it as it goes to the session page): a change at a
     * registered file's path, or at a folder on it, is read now — the stream batches what comes within 100 ms, and a
     * file caught half-written is read again with the next batch. `resync`: anything may have changed.
     */
    heard(update: FileChangeUpdate): void {
      for (const reg of byKey.values()) {
        if (!loadedAt(reg.abs) && reg.waiters.size === 0) continue;
        const touched = update.kind === 'resync' || update.changes.some((change) => reg.abs === change.path || reg.abs.startsWith(change.path + path.sep));
        if (touched) void look(reg).catch(() => warn('Local files: protected file is unavailable'));
      }
    },

    /** Tests and shutdown: every page's connection closes; what they changed is written first. Nobody waits any more. */
    async closeAll(): Promise<void> {
      for (const reg of byKey.values()) reg.waiters.clear();
      for (const document of hocuspocus.documents.values()) {
        for (const connection of document.getConnections()) connection.close();
      }
      await Promise.all([...hocuspocus.unloadingDocuments.values()]);
    },

    hocuspocus,
  };
}

export type LocalFileService = ReturnType<typeof createLocalFileService>;

/**
 * The folder a call names (`{ session }`'s working copy, `{ project }`'s root), as main found it on this computer, and who
 * asks: the page, and the file of that folder the host handed it (`ctx.file`), if any — it needs no capability.
 */
export interface LocalSurface {
  pageId: number;
  extensionId: string;
  /** Which folder this is, as the call named it. */
  place: WorkspacePlace;
  /** The folder's real path. */
  workspaceRoot: string;
  /** The file (relative to it) the host opened this page for, if it is in this folder: it needs no capability. */
  filePath: string | null;
}

/** What a local file's grant goes by: a path is only unique in its folder, and a page may hold two folders' files. */
const grantKey = (place: WorkspacePlace, rel: string) => `${placeKey(place)}/${rel}`;

/**
 * `gugu.files` on a session's working copy: the same verbs and gates as a chat's (`app-files-core.ts`), over the files
 * of the working copy a call names. The file the host handed the page needs nothing; any other needs `files:read`
 * (read-only) or `files:write` — the same two words, whichever session it is.
 */
export function createLocalAppFiles(platform: {
  service: LocalFileService;
  sync: FilesPlatform['sync'];
  hasCapability: FilesPlatform['hasCapability'];
  self(): Promise<LocalActor>;
}) {
  const { service, sync } = platform;
  const has = (surface: LocalSurface, capability: 'files:read' | 'files:write') => platform.hasCapability(surface.extensionId, capability);

  /** A path in the working copy, by its real path: a link that points outside it is not there (`resolvesInside`, the one check). */
  function inside(root: string, rel: string, what: 'existing' | 'new'): { abs: string; rel: string } {
    if (typeof rel !== 'string' || !rel || rel.includes('\0') || path.isAbsolute(rel)) {
      throw new AppFileError('invalid', 'Say which file, by its path in the working copy');
    }
    const target = resolvesInside(root, rel);
    try {
      if (!target || target === root) throw new Error('outside');
      const abs = what === 'existing' ? fs.realpathSync(target) : path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
      return { abs, rel: path.relative(root, abs).split(path.sep).join('/') };
    } catch {
      throw new AppFileError('not-found', `No file ${JSON.stringify(rel)} in this working copy`);
    }
  }

  /** The folders a new path needs, made only once it is known to be inside (R22): `../x/y` or a link out makes none outside. */
  function makeFolderOf(root: string, rel: string): void {
    const target = resolvesInside(root, rel);
    if (target) fs.mkdirSync(path.dirname(target), { recursive: true });
  }

  /** In a working copy a file's id and its name are the same thing: its path. */
  /** A file's path in the working copy. The host hands a page its file by the absolute path: inside the root, that is the same path. */
  const pathOf = (surface: LocalSurface, ref: WorkspaceFileRef) => {
    const name = 'id' in ref ? ref.id : ref.name;
    if (!path.isAbsolute(name)) return name;
    const rel = path.relative(surface.workspaceRoot, name);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : name;
  };

  const nameTaken = (rel: string) => new AppFileError('name-taken', `${rel} already exists`);

  /** What is at `rel` itself: a link stays the link, wherever it points. Its folder must be inside; the top is no entry to move or delete. */
  function entryAt(root: string, rel: string): { abs: string; rel: string } {
    const name = path.posix.basename(rel);
    const folder = path.posix.dirname(rel);
    const parent = folder === '.' ? { abs: fs.realpathSync(root), rel: '' } : inside(root, folder, 'existing');
    const abs = path.join(parent.abs, name);
    if (!name || name === '.' || name === '..' || !fs.lstatSync(abs, { throwIfNoEntry: false })) throw new AppFileError('not-found', `No file ${JSON.stringify(rel)} in this working copy`);
    return { abs, rel: path.posix.join(parent.rel, name) };
  }

  function moveEntry(surface: LocalSurface, from: { abs: string; rel: string }, wanted: string): AppFileEntry {
    makeFolderOf(surface.workspaceRoot, wanted);
    const to = inside(surface.workspaceRoot, wanted, 'new');
    if (to.abs === from.abs) throw new AppFileError('invalid', `${to.rel} is already there`);
    if (to.abs.startsWith(from.abs + path.sep)) throw new AppFileError('invalid', `${from.rel} cannot go inside itself`);
    // The same file under another case on a disk that does not tell them apart is a rename, not a clash.
    const at = fs.lstatSync(to.abs, { throwIfNoEntry: false });
    const was = fs.lstatSync(from.abs);
    if (at && (at.ino !== was.ino || at.dev !== was.dev)) throw nameTaken(to.rel);
    try {
      fs.renameSync(from.abs, to.abs);
    } catch (error) {
      throw new AppFileError('failed', `${from.rel} was not moved: ${messageOf(error)}`);
    }
    service.renamed(from.abs, to.abs, to.rel);
    const stat = fs.statSync(to.abs, { throwIfNoEntry: false }) ?? null;
    return stat?.isDirectory() ? workingCopyFolder(surface.place, to.rel) : workingCopyEntry(surface.place, to.rel, stat);
  }

  /** A file the page may read: the one handed to it, or any other with `files:read`/`:write`. */
  function readable(surface: LocalSurface, ref: WorkspaceFileRef, what: 'saving' | 'opening'): { abs: string; rel: string } {
    const found = inside(surface.workspaceRoot, pathOf(surface, ref), 'existing');
    requireHandedOr(found.rel === surface.filePath, (capability) => has(surface, capability), ['files:read', 'files:write'], what);
    if (!fs.statSync(found.abs).isFile()) throw new AppFileError('invalid', `${found.rel} is not a file`);
    return found;
  }

  async function open(surface: LocalSurface, args: { ref: WorkspaceFileRef; readOnly?: boolean }): Promise<AppFileOpened> {
    await requireAgentFileTreeAccess(surface.workspaceRoot);
    // The gate before a byte is read, as for a chat's files: the one handed to the page, or files:read / files:write.
    const found = readable(surface, args.ref, 'opening');
    const stat = fs.statSync(found.abs);
    // Over a document's size, or not text: read in pieces by the page (`f.read`, `f.blob`), as the file panel reads it —
    // never whole here, whatever its size.
    const kind = stat.size > MAX_BYTES ? null : documentKind(found.rel, fs.readFileSync(found.abs));
    if (kind?.kind !== 'document') {
      const opened = { entry: workingCopyEntry(surface.place, found.rel, stat), docName: '', access: 'ro' as const, self: await platform.self() };
      const raw = opensAsStoredText(found.rel, localContentType(found.rel), stat.size) ? fs.readFileSync(found.abs) : null;
      if (!raw || !workspaceStoredText(found.rel, localContentType(found.rel), raw)) return { ...opened, chunked: true };
      return { ...opened, bytes: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer };
    }
    const handedOver = found.rel === surface.filePath;
    let access: Grant['access'];
    let needs: Grant['needs'];
    if (handedOver) {
      access = args.readOnly ? 'ro' : 'rw';
      needs = null;
    } else if (!args.readOnly && has(surface, 'files:write')) {
      access = 'rw';
      needs = 'files:write';
    } else {
      access = 'ro';
      needs = has(surface, 'files:read') ? 'files:read' : 'files:write';
    }
    const self = await platform.self();
    const docName = service.register({ ...found, root: surface.workspaceRoot }, kind.contentType, self);
    sync.grant(sync.pageFor(surface.pageId, surface.extensionId), { docName, itemId: grantKey(surface.place, found.rel), access, needs });
    return { entry: workingCopyEntry(surface.place, found.rel, stat, kind.contentType), docName, access, self };
  }

  return {
    open,

    /** After `stale-epoch:<n>`: the same file under its new generation; the old grant is dropped. */
    async reopen(surface: LocalSurface, args: { ref: WorkspaceFileRef & { id: string }; readOnly?: boolean }): Promise<AppFileOpened> {
      const opened = await open(surface, { ref: args.ref, ...(args.readOnly ? { readOnly: true } : {}) });
      if (opened.bytes || opened.chunked) throw new AppFileError('invalid', `${opened.entry.id} is no longer a document (it is binary now, or over a document's size)`);
      const key = grantKey(surface.place, opened.entry.id);
      sync.revoke(surface.pageId, null, (grant) => grant.itemId === key && grant.docName !== opened.docName);
      return opened;
    },

    close(surface: LocalSurface, args: { docName: string }): void {
      sync.ungrant(surface.pageId, String(args.docName));
    },

    async create(surface: LocalSurface, args: { name: string; content: string }): Promise<AppFileEntry> {
      await requireAgentFileTreeAccess(surface.workspaceRoot);
      const name = String(args.name ?? '').trim();
      if (!name) throw new AppFileError('invalid', 'A file needs a name');
      const content = String(args.content ?? '');
      if (isJson(localContentType(name))) {
        try {
          parseJsonObject(content);
        } catch {
          throw new AppFileError('invalid', 'A JSON file must hold an object at the top');
        }
      }
      makeFolderOf(surface.workspaceRoot, name);
      const target = inside(surface.workspaceRoot, name, 'new');
      try {
        fs.writeFileSync(target.abs, content, { flag: 'wx', mode: FRESH_MODE });
      } catch (error) {
        if (code(error) === 'EEXIST') throw nameTaken(target.rel);
        throw error;
      }
      return workingCopyEntry(surface.place, target.rel, fs.statSync(target.abs));
    },

    /** A folder at `path`, made all the way down — refused when something is at that path already. */
    async mkdir(surface: LocalSurface, args: { path: string }): Promise<AppFileEntry> {
      await requireAgentFileTreeAccess(surface.workspaceRoot);
      const rel = String(args.path ?? '').trim();
      if (!rel) throw new AppFileError('invalid', 'A folder needs its path');
      makeFolderOf(surface.workspaceRoot, rel);
      const target = inside(surface.workspaceRoot, rel, 'new');
      try {
        fs.mkdirSync(target.abs);
      } catch (error) {
        if (code(error) === 'EEXIST') throw nameTaken(target.rel);
        throw new AppFileError('failed', `${target.rel} was not made: ${messageOf(error)}`);
      }
      return workingCopyFolder(surface.place, target.rel);
    },

    /** The entry itself moves or goes, never what a link points at: a link is named by its parent's real path and its own name. */
    async rename(surface: LocalSurface, args: { ref: WorkspaceFileRef; name: string }): Promise<AppFileEntry> {
      await requireAgentFileTreeAccess(surface.workspaceRoot);
      const name = String(args.name ?? '').trim();
      if (!name) throw new AppFileError('invalid', 'A file needs a name');
      const from = entryAt(surface.workspaceRoot, pathOf(surface, args.ref));
      // A bare name stays in its folder, as renaming a group file does; a path moves it.
      return moveEntry(surface, from, name.includes('/') ? name : path.posix.join(path.posix.dirname(from.rel), name));
    },

    /** Into `folder` ('' the top), under `name` when one is given. */
    async move(surface: LocalSurface, args: { ref: WorkspaceFileRef; folder?: string; name?: string }): Promise<AppFileEntry> {
      await requireAgentFileTreeAccess(surface.workspaceRoot);
      const from = entryAt(surface.workspaceRoot, pathOf(surface, args.ref));
      const folder = args.folder ?? path.posix.dirname(from.rel);
      return moveEntry(surface, from, path.posix.join(folder, args.name ?? path.posix.basename(from.rel)));
    },

    /**
     * G1 A stored file of the working copy written over with its next content — the bytes beside it, renamed over it.
     * Its history is the working copy's own (git). Gated like opening it read-write; a document changes through its open file.
     */
    async replace(surface: LocalSurface, args: { ref: WorkspaceFileRef; file: AppFileUpload }): Promise<AppFileEntry> {
      await requireAgentFileTreeAccess(surface.workspaceRoot);
      const file = args.file;
      if (!file || !(file.bytes instanceof ArrayBuffer)) throw new AppFileError('invalid', 'files.replace(file, content) takes the new content: a Blob');
      const found = inside(surface.workspaceRoot, pathOf(surface, args.ref), 'existing');
      if (found.rel !== surface.filePath && !has(surface, 'files:write')) {
        throw new AppFileError('denied', 'Not permitted: replacing a file other than the one this page was opened for needs "files:write"');
      }
      const stat = fs.statSync(found.abs);
      if (!stat.isFile()) throw new AppFileError('invalid', `${found.rel} is not a file`);
      if (stat.size <= MAX_BYTES && documentKind(found.rel, fs.readFileSync(found.abs))?.kind === 'document') {
        throw new AppFileError('invalid', `${found.rel} is a live text file: change it through files.open, it is never replaced`);
      }
      if (file.bytes.byteLength > APP_FILE_MAX_BYTES) throw tooLargeError([found.rel]);
      const tmp = path.join(path.dirname(found.abs), `.${path.basename(found.abs)}.${randomBytes(4).toString('hex')}.gugu-tmp`);
      try {
        fs.writeFileSync(tmp, new Uint8Array(file.bytes), { mode: stat.mode & 0o7777 });
        fs.renameSync(tmp, found.abs);
      } catch (error) {
        fs.rmSync(tmp, { force: true });
        throw new AppFileError('failed', `${found.rel} was not replaced: ${messageOf(error)}`);
      }
      return workingCopyEntry(surface.place, found.rel, fs.statSync(found.abs));
    },

    /** A file, a link (not what it points at) or a folder with all in it. */
    async remove(surface: LocalSurface, args: { ref: WorkspaceFileRef }): Promise<void> {
      await requireAgentFileTreeAccess(surface.workspaceRoot);
      const found = entryAt(surface.workspaceRoot, pathOf(surface, args.ref));
      try {
        fs.rmSync(found.abs, { recursive: true });
      } catch (error) {
        throw new AppFileError('failed', `${found.rel} was not deleted: ${messageOf(error)}`);
      }
      service.removed(found.abs);
    },

    /**
     * Where a file or folder of the working copy is on this computer, for a program of this computer. A file outside it is
     * the one handed to the page. `follow`: what opens it reads through a link, so the link must lead somewhere it may read.
     */
    async localPath(surface: LocalSurface, args: { ref: WorkspaceFileRef; follow?: boolean }): Promise<string> {
      const named = pathOf(surface, args.ref);
      if (path.isAbsolute(named)) return requireAgentFileAccess(named);
      await requireAgentFileTreeAccess(surface.workspaceRoot);
      if (!args.follow) return entryAt(surface.workspaceRoot, named).abs;
      return requireAgentFileAccess(inside(surface.workspaceRoot, named, 'existing').abs);
    },

    /** 「用 X 打开」 and saving: which file of the working copy, gated as opening it read-only. Who opens it is the host's to work out. */
    async openTarget(surface: LocalSurface, args: { ref: WorkspaceFileRef }): Promise<{ place: WorkspacePlace; path: string; name: string }> {
      await requireAgentFileTreeAccess(surface.workspaceRoot);
      const found = readable(surface, args.ref, 'opening');
      return { place: surface.place, path: found.rel, name: path.posix.basename(found.rel) };
    },
  };
}
