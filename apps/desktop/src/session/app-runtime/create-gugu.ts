import type { TabOpenIntent } from '@shared/view-state';
import { folderOf, placeKey, placeOf, type AppPlace } from '@shared/extensions/app-runtime-protocol';
import { DISPATCH_GONE } from '@shared/extensions/app-dispatch-core';
import { BRIDGE_VERBS, type ExtensionFileChangeBatch } from '@shared/extensions/bridge-protocol';
import { uploadInParts } from '@shared/extensions/working-copy-upload';
import { coded, guguError, refOf, type GuguHost } from './host';
import { createModalApi } from './modal';
import { countsOf } from './check-counts';
import { projectionSources } from './projection-source';
import { mountProjection } from './projection-view';

/**
 * `gugu` itself, built on a host — the same object wherever an App runs (F16): a page (desktop webview or
 * phone iframe, `gugu-entry.ts`) and an App's MCP program (`program-entry.ts`). What a host does not offer
 * is not there: a program has no editor and no clipboard, and its host refuses what needs a person's gesture.
 */

export type FilesModule = typeof import('./files-entry');
export type CodemirrorModule = typeof import('./codemirror-entry');
export type MarkdownModule = typeof import('./markdown-entry');

export function createGugu(
  raw: GuguHost & Record<string, unknown>,
  load: { files(): Promise<FilesModule>; codemirror?(): Promise<CodemirrorModule>; markdown?(): Promise<MarkdownModule> },
): Readonly<Record<string, unknown>> {
  // Every request verb and every `appFiles` call rejects with a coded Error (see `coded`);
  // subscriptions (`on…`) and `apiVersion` pass through as they are.
  const verbs = new Set(Object.keys(BRIDGE_VERBS));
  const appFiles = Object.fromEntries(
    Object.entries(raw.appFiles).map(([key, fn]) => [key, coded(fn as (...args: never[]) => unknown)]),
  ) as unknown as GuguHost['appFiles'];
  const host = { ...raw, reportError: coded(raw.reportError), appFiles } as GuguHost;
  /** Loaded with the first files verb: `bind.text` takes a file already open, so the module is here by then. */
  let filesModule: FilesModule | null = null;
  const loadFiles = () =>
    load.files().then((m) => {
      filesModule = m;
      return m;
    });
  let editor: CodemirrorModule | null = null;
  let editorLoading: Promise<CodemirrorModule['codemirror']> | null = null;

  /**
   * Each `files.onChanged(place, fn)` keeps its own host watch and caller, even at the same place. A watch the host
   * refuses (no `files:read`, a session not here) is reported as the
   * App's error — the call itself cannot reject, it returns the unsubscribe.
   */
  const watchers = new Map<string, (change: ExtensionFileChangeBatch) => void>();
  let nextWatch = 0;
  let hearing: (() => void) | null = null;
  const watch = (watchId: string, place: AppPlace & { folder?: string; id?: string }, on: boolean) =>
    host.appFiles.watch({ watchId, place, on }).catch((error: unknown) => {
      if (on) void host.reportError(`gugu.files.onChanged(${placeKey(place)}): ${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
    });
  function onChanged(place: unknown, handler: (change: ExtensionFileChangeBatch) => void): () => void {
    // A working copy may name a folder (`'.spec'`): what changes anywhere below it. Or one file (`id`, an entry or `ctx.file`).
    const { folder, id } = (place ?? {}) as { folder?: unknown; id?: unknown };
    const where = { ...placeOf(place), ...(typeof folder === 'string' && folder ? { folder } : {}), ...('workspace' in (place as object) && typeof id === 'string' && id ? { id } : {}) };
    const watchId = String(++nextWatch);
    if (typeof handler !== 'function') throw guguError('invalid', 'files.onChanged(place, fn) takes a function');
    hearing ??= host.onFilesChanged((id, change) => watchers.get(id)?.(change));
    watchers.set(watchId, handler);
    const registered = watch(watchId, where, true);
    return () => {
      if (watchers.delete(watchId)) void registered.then(() => watch(watchId, where, false));
    };
  }

  // The gesture halves, where the host has them: a page's (`VerbFacts.only`), never a background page's or a program's.
  const { upload, download, openWith, forward } = host.appFiles;
  /**
   * `files.replace(file, blob, { expectedVersion })` (G1): a stored file's next version; nothing to pick, so no gesture.
   * A chat's file needs `expectedVersion` (the entry's `version` as read): `content-changed` if it was replaced since,
   * `invalid` without it. A working copy's file has no versions and takes none.
   */
  const replace = (file: unknown, content: unknown, options?: { expectedVersion?: number }) =>
    withRef(file, async (ref) => {
      if (!(content instanceof Blob)) throw guguError('invalid', 'gugu.files.replace(file, content) takes the new content: a Blob or File');
      const expectedVersion = options?.expectedVersion ?? null;
      return host.appFiles.replace({ ref, file: { name: '', contentType: content.type, bytes: await content.arrayBuffer() }, expectedVersion });
    });
  // Every call names where its file is (真源原则 13): an entry or `ctx.file` carries it, a place says it.
  const files = Object.freeze({
    open: (file: unknown, options?: { readOnly?: boolean }) => {
      const counts = countsOf(host);
      counts?.opened();
      return withRef(file, (ref) => {
        const entry = (file as { entry?: { version?: unknown }; version?: unknown } | null)?.entry ?? file as { version?: unknown } | null;
        const requested = host.appFiles.open({ ref, ...(!host.program ? { deferDetails: true } : {}), ...(typeof entry?.version === 'number' ? { expectedVersion: entry.version } : {}), ...(options?.readOnly === true ? { readOnly: true } : {}) });
        const opening = loadFiles().then((m) => m.openFile(host, requested));
        // Observe a fast refusal even while the runtime is still loading.
        return Promise.all([opening, requested]).then(([opened]) => opened);
      }).finally(() => counts?.openSettled());
    },
    list: (place: unknown) => loadFiles().then((m) => m.listEntries(host, place)),
    /** Across every chat the reader is in, needing `files:read`: by a piece of the path, newest first; what this person opened last. */
    search: (options?: unknown) => loadFiles().then((m) => m.searchEntries(host, options)),
    recent: (options?: unknown) => loadFiles().then((m) => m.recentEntries(host, options)),
    create: (target: unknown, content: string | object, options?: { contentType?: string; sourceMessageIds?: string[] }) =>
      loadFiles().then((m) => m.createFile(host, target, content, options)),
    remove: (file: unknown) => loadFiles().then((m) => m.removeFile(host, file)),
    rename: (file: unknown, name: string) => loadFiles().then((m) => m.renameFile(host, file, name)),
    /** 「设为临时 / 一直保留」: `'temporary'` clears its cloud copy after the uploader's period, from now; `'permanent'` keeps it. */
    keep: (files: unknown, how: 'temporary' | 'permanent') => withRefs(files, (refs) => host.appFiles.keep({ refs, how })),
    /** 子文件夹: a chat's folder at `path` (made all the way down), and a file or folder moved into another (`''` the top). */
    mkdir: (target: unknown) => loadFiles().then((m) => m.makeFolder(host, target)),
    move: (file: unknown, to: unknown) => loadFiles().then((m) => m.moveFile(host, file, to)),
    onChanged,
    viewPreferences: (place: unknown, options?: { showAppData?: boolean }) => withPlace(place, (where) => host.appFiles.viewPreferences({ place: where, ...options })),
    replace,
    /** A working copy's text whole, where the page holds it and no live document does; and whether it is there. */
    readText: (file: unknown, options?: { maxBytes?: number; onProgress?: (done: number, total: number) => void }) => withRef(file, (ref) => {
      const read = { ref, ...(options?.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }) };
      const hearing = options?.onProgress && (raw.onDownloadProgress as ((hear: (id: string, done: number, total: number) => void) => () => void) | undefined);
      if (!hearing) return host.appFiles.readText(read);
      const transferId = crypto.randomUUID();
      const off = hearing((id, done, total) => { if (id === transferId) options!.onProgress!(done, total); });
      return host.appFiles.readText({ ...read, transferId }).finally(off);
    }),
    exists: (file: unknown) => withRef(file, (ref) => host.appFiles.exists({ ref })),
    /** A file's unsaved edits, kept on its machine for after a crash: read (no `text`), kept, dropped (`null`). */
    draft: (file: unknown, text?: string | null) => withRef(file, (ref) => host.appFiles.draft({ ref, ...(text === undefined ? {} : { text }) })),
    /** Saves over the version `readText` read: `content-changed` when the disk moved on since. */
    writeText: (file: unknown, text: string) => withRef(file, (ref) => host.appFiles.writeText({ ref, text })),
    /** Whether whoever reads may delete each file (an entry, or a list of them), in order — ask as its menu opens. */
    canDelete: (files: unknown) => withRefs(files, (refs) => host.appFiles.canDelete({ refs })),
    /** G2 A chat file's kept versions, newest first; one's content: a text file's as text, a stored file's as a Blob. */
    versions: (file: unknown) => withRef(file, (ref) => host.appFiles.versions({ ref })),
    readVersion: (file: unknown, n: number) =>
      withRef(file, async (ref) => {
        const version = await host.appFiles.readVersion({ ref, n });
        return 'text' in version ? version.text : new Blob([version.bytes], { type: version.contentType });
      }),
    // Straight to the host, not through the lazily loaded module: the picker and the save dialog
    // are allowed only inside the person's gesture, checked on this very call. Bytes the caller has need none (G5).
    // A4 `{ sourceMessageIds }`: the messages the files came from, as an entry gives them back.
    // 子文件夹 `{ chat, folder }`: the folder they go in (its path or id, made all the way down); not given, the top.
    // `{ keep }` 临时 / 保留: how long a stored copy stays ('temporary' | 'permanent'); not given, the chat's rule.
    // Into a working copy, `{ replace, onProgress, signal }`: bytes go in parts, a file of any size; one already there is
    // `name-taken` until `replace` says so; progress is the bytes sent of them all; `signal` stops it, nothing arrives.
    upload: (place: unknown, file?: unknown, options?: { sourceMessageIds?: string[]; keep?: string; replace?: boolean; onProgress?: (sent: number, total: number) => void; signal?: AbortSignal }) =>
      withPlace(place, (where) => {
        // Checked as list and create check it (folderOf): what is not a folder's path, id or entry is `invalid`.
        let folder: string | undefined;
        try {
          folder = folderOf((place as { folder?: unknown } | null)?.folder);
        } catch (error) {
          return Promise.reject(guguError('invalid', error instanceof Error ? error.message : String(error)));
        }
        if (file !== undefined && 'workspace' in where) {
          const blobs = (Array.isArray(file) ? file : [file]) as (Blob & { name?: unknown })[];
          if (blobs.length === 0 || blobs.some((blob) => !(blob instanceof Blob) || typeof blob.name !== 'string' || !blob.name)) return Promise.reject(guguError('invalid', 'gugu.files.upload takes a File, or a Blob with a name'));
          return uploadInParts((part) => host.appFiles.writeChunk(part), where, blobs.map((blob) => ({ name: blob.name as string, blob })), folder, options);
        }
        const into = { ...(folder === undefined ? {} : { folder }), ...(options?.keep === undefined ? {} : { keep: options.keep }) };
        return file === undefined
          ? upload({ place: where, sourceMessageIds: options?.sourceMessageIds, ...into })
          : uploadsOf(file).then((uploads) => upload({ place: where, files: uploads, sourceMessageIds: options?.sourceMessageIds, ...into }));
      }),
    ...(download && openWith
      ? {
          // API 20: several files at once — one 「save to」 for them all (a folder on the desktop, the share sheet on the phone).
          // A working copy's folder (`entry.type: 'folder'`): saved whole. `{ onProgress, signal }`, one file or folder of a
          // working copy: the bytes saved of them all, and stopping it: nothing is left where it was going.
          download: (files: unknown, options?: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal }) => (Array.isArray(files)
            ? withRefs(files, (refs) => download({ refs }))
            : withRef(files, (ref) => {
              const folder = (files as { type?: unknown } | null)?.type === 'folder' ? { folder: true } : {};
              if (!options?.onProgress && !options?.signal) return download({ ref, ...folder });
              const transferId = crypto.randomUUID();
              const off = (raw.onDownloadProgress as ((hear: (id: string, done: number, total: number) => void) => () => void) | undefined)?.((id, done, total) => { if (id === transferId) options.onProgress?.(done, total); });
              const stop = () => void host.appFiles.downloadStop?.({ transferId });
              options.signal?.addEventListener('abort', stop);
              return download({ ref, ...folder, transferId }).finally(() => {
                off?.();
                options.signal?.removeEventListener('abort', stop);
              });
            })),
          // `{ ask: true }`: 「用别的 App 打开」 — every App that opens it, the person picks. `{ at }`: the place in it (a pill's).
          // `{ peek: true }`: beside this page, which stays as it is (G1).
          openWith: (file: unknown, options?: { ask?: boolean; at?: Record<string, string>; peek?: boolean; tab?: string; intent?: TabOpenIntent; viewState?: Record<string, unknown> }) =>
            // A folder of the working copy, not a file: `{ workspace, folder }`, its list in this tab.
            typeof (file as { folder?: unknown } | null)?.folder === 'string'
              ? openWith({ ref: file as never })
              : withRef(file, (ref) =>
              openWith({ ref, ...(options?.viewState ? { viewState: options.viewState } : {}), ...(options?.ask === true ? { ask: true } : {}), ...(options?.at ? { at: options.at } : {}), ...(options?.peek === true ? { peek: true } : {}), ...(Object.hasOwn(options ?? {}, 'tab') ? { tab: options?.tab } : {}), ...(Object.hasOwn(options ?? {}, 'intent') ? { intent: options?.intent } : {}) })),
        }
      : {}),
    // API 23: 「转发」 — one file or several, the host's forward page; resolves once it is up (what is sent is the person's).
    // `{ onProgress, signal }`: a working copy's file is read first, and that can be followed and stopped as a download can.
    ...(forward ? { forward: (files: unknown, options?: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal }) => withRefs(files, (refs) => {
      if (!options?.onProgress && !options?.signal) return forward({ refs });
      const transferId = crypto.randomUUID();
      const off = (raw.onDownloadProgress as ((hear: (id: string, done: number, total: number) => void) => () => void) | undefined)?.((id, done, total) => { if (id === transferId) options.onProgress?.(done, total); });
      const stop = () => void host.appFiles.downloadStop?.({ transferId });
      options.signal?.addEventListener('abort', stop);
      return forward({ refs, transferId } as never).finally(() => {
        off?.();
        options.signal?.removeEventListener('abort', stop);
      });
    }) } : {}),
    ...(host.appFiles.reveal ? { reveal: (file: unknown) => withRef(file, (ref) => host.appFiles.reveal!({ ref })) } : {}),
    ...(host.appFiles.openIn ? { openInApps: () => host.appFiles.openInApps!({}), openIn: (file: unknown, app: string) => withRef(file, (ref) => host.appFiles.openIn!({ ref, app })) } : {}),
  });

  // Every v1 member; `appFiles`, `chats`, `checkPage`, `clipboard`, `messages`, `projects`, `theme` and `onFilesChanged` (it is
  // `files.onChanged`) are host halves.
  const api: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (['navigationGo', 'navigationClaimBack', 'onBack', 'appFiles', 'chats', 'checkPage', 'clipboard', 'messages', 'cloud', 'framed', 'program', 'projects', 'sessions', 'theme', 'onFilesChanged', 'onDownloadProgress', 'onCloudHeard', 'modal', 'onModalFocus', 'projection', 'onProjection', 'onProjectionSource'].includes(key)) continue;
    api[key] = typeof value === 'function' && verbs.has(key) ? coded(value as (...args: never[]) => unknown) : value;
  }
  api.files = files;
  if (raw.navigationGo) api.navigation = Object.freeze({
    go: (delta: unknown): Promise<boolean> => {
      if (delta !== -1 && delta !== 1) return Promise.reject(guguError('invalid', 'Navigation delta must be -1 or 1'));
      return coded(raw.navigationGo!)({ delta });
    },
    // @@@back-step - while held, the host's Back (the phone's back key / edge swipe) is the page's own step (a folder up), not
    // leaving the page. Resolves to the release; a host with no Back of its own (a desktop tab) resolves, never calls it.
    ...(raw.navigationClaimBack && raw.onBack ? {
      onBack: async (handler: unknown): Promise<() => Promise<void>> => {
        if (typeof handler !== 'function') throw guguError('invalid', 'gugu.navigation.onBack takes a function');
        const off = raw.onBack!(() => handler());
        try { await coded(raw.navigationClaimBack!)(true); }
        catch (error) { off(); throw error; }
        return async () => { off(); await coded(raw.navigationClaimBack!)(false); };
      },
    } : {}),
  });
  if (host.program && host.projection && host.onProjectionSource) api.projection = projectionSources(host);
  else if (host.projection && host.onProjection) api.projection = {
    mount: (element: HTMLElement, id: string, options?: Parameters<typeof mountProjection>[3]) => mountProjection(host, element, id, options),
  };
  if (raw.modal) api.modal = createModalApi(raw);
  // `gugu.dispatch(text, { …, images })` (G3): Blobs become bytes here, the one shape every host carries.
  if (typeof raw.dispatch === 'function') {
    const dispatch = raw.dispatch as (text: unknown, options?: Record<string, unknown>) => Promise<unknown>;
    api.dispatch = coded(async (text: unknown, options?: Record<string, unknown>) => {
      const images = options?.images;
      if (images === undefined) return dispatch(text, options);
      if (!Array.isArray(images)) throw guguError('invalid', 'gugu.dispatch(text, { images }) takes a list of Blobs or Files');
      const carried = await Promise.all(
        images.map(async (image: unknown) => {
          if (!(image instanceof Blob)) throw guguError('invalid', 'gugu.dispatch(text, { images }) takes a list of Blobs or Files');
          const name = (image as Blob & { name?: unknown }).name;
          return { name: typeof name === 'string' ? name : '', type: image.type, bytes: await image.arrayBuffer() };
        }),
      );
      return dispatch(text, { ...options, images: carried });
    });
  }
  // The calls of before 15 say where they went, instead of being simply missing: an App written for 14 is told what to call.
  for (const [gone, why] of Object.entries(DISPATCH_GONE)) api[gone] = () => Promise.reject(guguError('invalid', why));
  /**
   * Collaborative text in a JSON file (摩擦单 F8): `{ $text: initial }`, the form the file service builds a Y.Text from
   * (an agent writes the same in its data). Read back it is a plain string; `f.textAt(path)` edits it letter by letter.
   */
  api.text = (initial: unknown = '') => {
    if (typeof initial !== 'string') throw guguError('invalid', 'gugu.text takes the text to start with, a string');
    return Object.freeze({ $text: initial });
  };
  if (load.codemirror) {
    const loadCodemirror = load.codemirror;
    api.bind = Object.freeze({
      codemirror(view: unknown, file: unknown) {
        if (!editor) throw guguError('invalid', 'Load the editor with await gugu.codemirror() and build the view from it first');
        // A picture pasted or dropped in goes in through this page's own upload (its grants, its gesture rules).
        return editor.bindCodemirror(view, file, { upload: files.upload, reportError: host.reportError });
      },
      /** A text file on a `<textarea>` / `<input>`, or on a view the App draws (摩擦单 F59): `text-binding.ts`. */
      text(view: unknown, file: unknown) {
        if (!filesModule) throw guguError('invalid', 'bind.text takes a text file from await gugu.files.open(…)');
        return filesModule.bindText(view, file);
      },
    });
    api.codemirror = () =>
      (editorLoading ??= loadCodemirror().then((m) => {
        editor = m;
        return m.codemirror;
      }));
  }
  // Called straight through, not deferred: the preload checks the person's gesture on this very call.
  if (raw.clipboard) api.clipboard = Object.freeze({ writeText: coded(raw.clipboard.writeText) });
  // `gugu.messages` (`chat:read`): a chat's timeline or thread, and the messages holding a text or naming a file.
  if (raw.messages) api.messages = Object.freeze({ history: coded(raw.messages.history), search: coded(raw.messages.search) });
  // `gugu.chats` (`chat:read`): the chats whoever reads is in, and who is in one.
  if (raw.chats) api.chats = Object.freeze({ list: coded(raw.chats.list), members: coded(raw.chats.members) });
  // `gugu.projects` (`files:read`): this computer's projects — a phone has none, and no member.
  if (raw.projects) api.projects = Object.freeze({ list: coded(raw.projects.list) });
  if (raw.sessions) api.sessions = Object.freeze({ index: coded(raw.sessions.index), read: coded(raw.sessions.read) });
  // `gugu.cloud` (31): `on(topic, event, fn)` is a page's: one subscription per topic and event with the host, however many
  // handlers, as `files.onChanged` watches a place; one the host refuses is reported as the App's error.
  if (raw.cloud) {
    const cloud = raw.cloud;
    const write = cloud.write ?? cloud.programWrite;
    const on = cloud.subscribe && cloud.unsubscribe && raw.onCloudHeard ? (() => {
      type Heard = { subscribed: true } | { payload: Record<string, unknown> };
      const { subscribe, unsubscribe } = cloud as Required<typeof cloud>;
      const onCloudHeard = raw.onCloudHeard!;
      const listeners = new Map<string, Set<(heard: Heard) => void>>();
      const keyOf = (topic: string, event: string) => `${topic}\n${event}`;
      let hearing: (() => void) | null = null;
      return (topic: unknown, event: unknown, handler: (heard: Heard) => void): (() => void) => {
        if (typeof topic !== 'string' || !topic || typeof event !== 'string' || !event) throw guguError('invalid', 'cloud.on(topic, event, fn) names a topic and an event');
        if (typeof handler !== 'function') throw guguError('invalid', 'cloud.on(topic, event, fn) takes a function');
        hearing ??= onCloudHeard((heardTopic, heardEvent, heard) => {
          for (const fn of listeners.get(keyOf(heardTopic, heardEvent)) ?? []) fn(heard);
        });
        const key = keyOf(topic, event);
        let handlers = listeners.get(key);
        if (!handlers) {
          handlers = new Set();
          listeners.set(key, handlers);
          subscribe(topic, event).catch((error: unknown) => {
            void host.reportError(`gugu.cloud.on(${topic}): ${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
          });
        }
        handlers.add(handler);
        return () => {
          const current = listeners.get(key);
          if (!current?.delete(handler) || current.size > 0) return;
          listeners.delete(key);
          void unsubscribe(topic, event).catch(() => undefined);
        };
      };
    })() : undefined;
    api.cloud = Object.freeze({
      read: coded(cloud.read),
      ...(write ? { write: coded(write) } : {}),
      ...(on ? { on } : {}),
    });
  }
  // The host's markdown rendering for a page (markdown-entry.ts): links in it go through this very `gugu`.
  if (load.markdown) {
    const loadMarkdown = load.markdown;
    let markdown: ReturnType<MarkdownModule['markdownFor']> | null = null;
    api.markdown = () => (markdown ??= loadMarkdown().then((m) => m.markdownFor(api as never)));
  }
  return Object.freeze(api);
}

/** `refOf` throws on what is not a file; a verb answers that as a rejection, like every other. */
/** One file or several (API 20: files.keep, files.download): each a ref, as withRef reads one; none is `invalid`. */
function withRefs<T>(files: unknown, run: (refs: ReturnType<typeof refOf>[]) => Promise<T>): Promise<T> {
  let refs: ReturnType<typeof refOf>[];
  try {
    refs = (Array.isArray(files) ? files : [files]).map((file) => refOf(file));
  } catch (error) {
    return Promise.reject(error);
  }
  if (refs.length === 0) return Promise.reject(Object.assign(new Error('Give one file or more'), { code: 'invalid' }));
  return run(refs);
}

function withRef<T>(file: unknown, run: (ref: ReturnType<typeof refOf>) => Promise<T>): Promise<T> {
  let ref: ReturnType<typeof refOf>;
  try {
    ref = refOf(file);
  } catch (error) {
    return Promise.reject(error);
  }
  return run(ref);
}

/** `placeOf` throws on what is not a place; a verb answers that as a rejection, coded `invalid`. */
function withPlace<T>(place: unknown, run: (where: AppPlace) => Promise<T>): Promise<T> {
  let where: AppPlace;
  try {
    where = placeOf(place);
  } catch (error) {
    return Promise.reject(guguError('invalid', error instanceof Error ? error.message : String(error)));
  }
  return run(where);
}

/** What `files.upload(file)` was handed — a File, or a Blob with a `name`, or a list of them — as bytes. */
async function uploadsOf(file: unknown): Promise<{ name: string; contentType: string; bytes: ArrayBuffer }[]> {
  const blobs = Array.isArray(file) ? file : [file];
  if (blobs.length === 0) throw guguError('invalid', 'gugu.files.upload takes a File, or a Blob with a name');
  return Promise.all(
    blobs.map(async (blob) => {
      const name = blob instanceof Blob ? (blob as Blob & { name?: unknown }).name : undefined;
      if (!(blob instanceof Blob) || typeof name !== 'string' || !name.trim()) {
        throw guguError('invalid', 'gugu.files.upload takes a File, or a Blob with a name');
      }
      return { name, contentType: blob.type, bytes: await blob.arrayBuffer() };
    }),
  );
}
