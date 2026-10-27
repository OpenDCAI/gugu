import { MessageChannelMain, webContents } from 'electron';
import WebSocket from 'ws';
import { getSupabaseUrl } from '@gugu/core/cloud/config';
import {
  FileSyncRelay,
  webSocketUrl,
  type Grant,
  type PagePort,
  type PageSync,
  type FileSyncPlatform,
} from '@shared/extensions/file-sync-core';
import { SYNC_PORT_CHANNEL, type SyncRevokeReason } from '@shared/extensions/app-runtime-protocol';
import { extensionsService } from '@main/core/extensions/extensions-root';
import { currentAccountAccessToken } from '@main/core/extensions/account-token';
import { log } from '@main/lib/logger';
import { tapMainEvents } from '@main/lib/events';
import { fileChangesChannel, type FileChangesEvent } from '@shared/core/fs/fsEvents';
import { createLocalFileService } from '@main/core/extensions/local-files';

/**
 * The App file sync relay on the desktop: the shared relay (`file-sync-core.ts`) running in main,
 * over `ws` to the file service and a MessageChannelMain port to each App page's webContents.
 * The phone runs the same relay in the outer gugu page (components/appSlot).
 *
 * A task's working copy is served by the local file service in this process (`local-files.ts`): the relay's
 * `connectLocal`, for the `wc:` documents.
 */

/** Task working copies' open files (`gugu.files` in a task). */
export const localFileService = createLocalFileService({ warn: (message, data) => log.warn(message, data) });
// What it hears of the disk: each task working copy's change stream (workspace-factory's `watchChanges`, the file tree's
// and search index's), as main sends it to the session page — one watch per working copy, not a second one of its own.
tapMainEvents((channel, data) => {
  if (channel === fileChangesChannel.name) localFileService.heard((data as FileChangesEvent).update);
});

/** Where the file service is: `GUGU_FILES_URL` (local/prototype), else `<supabase>/files`. */
export function fileServiceUrl(): string {
  const configured = process.env.GUGU_FILES_URL?.trim();
  return (configured || `${getSupabaseUrl().replace(/\/+$/, '')}/files`).replace(/\/+$/, '');
}

const platform: FileSyncPlatform = {
  serviceUrl: () => webSocketUrl(fileServiceUrl()),
  connect(url, protocols, events) {
    const ws = new WebSocket(url, protocols, { handshakeTimeout: 10_000 });
    ws.binaryType = 'nodebuffer';
    ws.on('open', () => events.open());
    ws.on('message', (data: Buffer) => events.message(new Uint8Array(data)));
    ws.on('pong', () => events.pong());
    ws.on('close', (code: number, reason: Buffer) => events.close(code, reason.toString()));
    ws.on('error', (error: Error) => events.error(error.message));
    return {
      send: (frame) => ws.send(frame),
      close: (code, reason) => ws.close(code, reason),
      ping: () => {
        ws.ping();
        return true;
      },
      terminate: () => ws.terminate(),
    };
  },
  connectLocal: (events) => localFileService.connect(events),
  awaitLocalReturn: (docName, back) => localFileService.awaitReturn(docName, back),
  token: () => currentAccountAccessToken(),
  hasCapability: (extensionId, capability) => extensionsService().hasCapability(extensionId, capability),
  warn: (message, data) => log.warn(message, data),
  note: (message, data) => log.info(message, data),
};

const relay = new FileSyncRelay(platform);

/** This page's open files state, creating its port (and posting it to the page) the first time. */
function pageFor(webContentsId: number, extensionId: string): PageSync {
  const existing = relay.page(webContentsId);
  if (existing) return existing;
  const contents = webContents.fromId(webContentsId);
  if (!contents || contents.isDestroyed()) throw new Error('This surface is gone');
  const { port1, port2 } = new MessageChannelMain();
  // A reload or a navigation is a new document with a new runtime: the old one's open files end
  // here exactly as if the page had closed (its next `files.open` gets a fresh port).
  const navigated = () => relay.pageGone(webContentsId);
  const page = relay.attachPage(
    webContentsId,
    extensionId,
    { post: (message) => port1.postMessage(message), close: () => port1.close() },
    () => contents.removeListener('did-navigate', navigated),
  );
  port1.on('message', (event) => relay.fromPage(page, event.data));
  port1.on('close', () => relay.pageGone(webContentsId));
  port1.start();
  contents.postMessage(SYNC_PORT_CHANNEL, null, [port2]);
  log.info('File sync: port posted to the page', { page: webContentsId, extensionId });
  contents.on('did-navigate', navigated);
  contents.once('destroyed', () => relay.pageGone(webContentsId));
  return page;
}

export const fileSync = {
  ensureFor: (asAgent: string | null) => { relay.ensureFor(asAgent); },
  pageFor,
  grant: (page: PageSync, grant: Grant) => {
    log.info('File sync: file granted to the page', { page: page.id, extensionId: page.extensionId, itemId: grant.itemId, access: grant.access });
    relay.grant(page, grant);
  },
  ungrant: (webContentsId: number, docName: string) => relay.ungrant(webContentsId, docName),
  revoke: (webContentsId: number, reason: SyncRevokeReason | null, docNames?: (grant: Grant) => boolean) =>
    relay.revoke(webContentsId, reason, docNames),
  revokeExtension: (extensionId: string, reason: SyncRevokeReason) => relay.revokeExtension(extensionId, reason),
  // F16 An App's program on the relay: its IPC channel stands where a page's MessagePort does.
  attachPort: (id: number, extensionId: string, port: PagePort) => relay.attachPage(id, extensionId, port),
  fromPort: (page: PageSync, data: unknown) => relay.fromPage(page, data),
  pageGone: (id: number) => relay.pageGone(id),
  /** How many files a surface holds open now. */
  openCount: (id: number) => relay.page(id)?.grants.size ?? 0,
};

export type { Grant, PageSync };
