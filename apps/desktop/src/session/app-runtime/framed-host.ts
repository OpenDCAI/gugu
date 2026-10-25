import { APP_FRAME_MARKER, APP_SESSION_FRAME_NAME, type FrameToHost, type HostToFrame } from '@shared/extensions/app-runtime-protocol';
import { EXTENSION_API_VERSION } from '@shared/extensions/bridge-protocol';
import { hostEventHub, hostMembers, type HostMember } from '@shared/extensions/host-calls';
import type { GuguHost } from './host';

/**
 * The host of an App running in an iframe of the outer gugu page — the phone (真源 §2.2). The
 * same shape the desktop preload exposes as `__guguHost`, over postMessage to `window.parent`.
 *
 * Only what the phone offers is here: a verb that is missing is missing, and an App feature-
 * detects it (`typeof gugu.x`), exactly as it would on a host without a capability. Everything
 * here is a request; the outer page decides every answer from its own binding of this frame,
 * and reads the person's gesture itself.
 */
export function framedHost(): GuguHost & Record<string, unknown> {
  const parent = window.parent;
  // A session's tab names its frame (SessionAppFrame): only there is there a computer whose program a page can call.
  const inSession = window.name === APP_SESSION_FRAME_NAME;
  // This document's start, ahead of its first call: the outer page lets go of what the frame's previous document held.
  parent.postMessage({ m: APP_FRAME_MARKER, t: 'hello' } satisfies FrameToHost, '*');
  return messageHost(
    {
      post: (message) => parent.postMessage(message, '*'),
      listen: (handler) =>
        window.addEventListener('message', (event) => {
          if (event.source === parent) handler(event.data);
        }),
    },
    { framed: true, ...(inSession ? { session: true as const } : {}) },
  );
}

/**
 * What the phone's host answers (phoneAppHost.ts) — the rest of `HOST_CALLS` is not on a phone frame at all. In a session's
 * tab (owner 10-16) also the App's program on that session's computer; anywhere else the phone has none, so the verbs are
 * not there (an App tells the phone by `typeof gugu.callProgram`).
 */
const PHONE: ReadonlySet<HostMember> = new Set<HostMember>([
  'modal.open', 'modal.close', 'modal.key', 'onModalFocus',
  'getContext', 'onContextChanged', 'onFilesChanged', 'reportError', 'openBrowserTab', 'dispatch', 'messages.history', 'messages.search',
  'chats.list', 'chats.members', 'linkTo', 'openLink',
  'forum.list', 'forum.read', 'forum.post', 'forum.reply', 'forum.react', 'forum.remove', 'forum.block', 'forum.assign', 'forum.award',
  'forum.subscribe', 'forum.unsubscribe', 'onForumChanged',
  'setTabTitle', 'setTabBadge', 'onCommand', 'onLink', 'showMessage', 'showSession', 'clipboard.writeText',
  'readData', 'writeData', 'listData',
  'appFiles.open', 'appFiles.reopen', 'appFiles.close', 'appFiles.list', 'appFiles.search', 'appFiles.recent', 'appFiles.create',
  'appFiles.remove', 'appFiles.rename', 'appFiles.mkdir', 'appFiles.move', 'appFiles.watch', 'appFiles.replace',
  'appFiles.versions', 'appFiles.readVersion', 'appFiles.upload', 'appFiles.openWith', 'appFiles.download',
]);
const IN_SESSION: ReadonlySet<HostMember> = new Set<HostMember>(['callProgram', 'onProgramNotification']);
/** What main answers an App's MCP program (F16): its files and messages, an agent's word — no page, no data folder of a page. */
const PROGRAM: ReadonlySet<HostMember> = new Set<HostMember>([
  'getContext', 'onContextChanged', 'onFilesChanged', 'reportError', 'openBrowserTab', 'dispatch', 'messages.history', 'messages.search',
  'chats.list', 'chats.members', 'projects.list', 'linkTo',
  'appFiles.open', 'appFiles.reopen', 'appFiles.close', 'appFiles.list', 'appFiles.search', 'appFiles.recent', 'appFiles.create',
  'appFiles.remove', 'appFiles.rename', 'appFiles.mkdir', 'appFiles.move', 'appFiles.watch', 'appFiles.replace',
  'appFiles.versions', 'appFiles.readVersion', 'appFiles.upload',
]);

/**
 * The same host over any two-way message channel: an iframe's parent (the phone), or a program's IPC
 * channel to main (F16 — an App's MCP program gets the same `gugu`). One protocol, one implementation.
 */
export function messageHost(
  transport: { post(message: FrameToHost): void; listen(handler: (message: unknown) => void): void },
  flags: { framed?: true; program?: true; session?: true },
): GuguHost & Record<string, unknown> {
  let seq = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
  const events = hostEventHub();

  transport.listen((data) => {
    const message = data as HostToFrame | null;
    if (!message || message.m !== APP_FRAME_MARKER) return;
    if (message.t === 'result') {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      // Rejected with a plain `{ code, message, detail }`, as the preload does; `coded` makes it an Error.
      if (message.ok) waiting.resolve(message.value);
      else waiting.reject({ code: message.code, message: message.message, ...(message.detail ? { detail: message.detail } : {}) });
    } else if (message.t === 'event') {
      events.deliver(message.event);
    }
  });

  const call = (method: string, args: unknown = {}): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      transport.post({ m: APP_FRAME_MARKER, t: 'call', id, method, args });
    });
  const offers = (member: HostMember) => (flags.program ? PROGRAM.has(member) : PHONE.has(member) || (!!flags.session && IN_SESSION.has(member)));
  return {
    apiVersion: EXTENSION_API_VERSION,
    ...flags,
    ...hostMembers(flags.program ? 'program' : 'page', offers, call, events.on),
  } as GuguHost & Record<string, unknown>;
}
