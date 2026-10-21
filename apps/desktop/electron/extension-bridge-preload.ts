import { contextBridge, ipcRenderer } from 'electron';
import { installProcessMetricsResponder } from './process-metrics-responder';

import {
  BACKGROUND_PAGE_ARG,
  EXTENSION_API_VERSION,
  EXTENSION_BRIDGE_CHANNEL,
  EXTENSION_BRIDGE_EVENT_CHANNEL,
  EXTENSION_THEME_CHANNEL,
  gestureRefusal,
  needsGesture,
  CHECK_PAGE_ARG,
  type PageCounts,
  type ExtensionBridgeResponse,
  type ExtensionHostEvent,
} from '../src/session/shared/extensions/bridge-protocol';
import { SYNC_PORT_CHANNEL, SYNC_PORT_REQUEST, SYNC_PORT_WINDOW_MESSAGE } from '../src/session/shared/extensions/app-runtime-protocol';
import { hostEventHub, hostMembers } from '../src/session/shared/extensions/host-calls';

installProcessMetricsResponder(ipcRenderer, process, 'app');

/**
 * The bridge an extension surface gets, and the only thing it gets.
 *
 * Exposed as `__guguHost`, not as `gugu`: the page's `window.gugu` is built by the platform
 * runtime (`/_gugu/<ver>/gugu.js`, which the host puts first in every App document). An
 * open file is a live Y.Doc bound to a live editor, and both must live in the App's own JS
 * world — anything crossing contextBridge is a copy. The runtime copies every member below
 * onto `window.gugu` verbatim, and builds `files` / `bind` / `codemirror` on top of
 * `appFiles` and the sync port.
 *
 * This file is the reason `hardenExtensionWebviewPreferences` deletes whatever
 * preload the renderer asked for: a preload runs with more authority than the
 * page, so **which** script that is has to be the main process's decision. The
 * renderer names a partition; main names this file.
 *
 * Everything here is a request, never an authority: each call crosses to main,
 * which resolves who is asking from the *session* the call arrived on — never
 * from anything in the payload — and checks it against what the user granted.
 * A compromised surface can lie about its arguments; it cannot lie about which
 * session it is running in. Refs #2374.
 */

async function call(method: string, args?: unknown): Promise<unknown> {
  // A verb that needs the person's gesture (a click, a key) is checked here, in the preload's world, where a page
  // script can neither fake nor extend it — and before anything is awaited: the activation lapses.
  if (needsGesture(method, args) && !(navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive) {
    throw gestureRefusal(method);
  }
  const response = (await ipcRenderer.invoke(EXTENSION_BRIDGE_CHANNEL, {
    method,
    args,
  })) as ExtensionBridgeResponse;
  if (response.ok) return response.value;
  // Carrying the code out means an extension can tell "the user said no" apart
  // from "that failed" and stop asking, instead of retrying against a wall.
  //
  // Rejected with a plain object, not an Error: contextBridge copies an Error as its message
  // only, so `code` never reached a page (measured 09-29 on the v1 verbs too). A plain object
  // crosses intact, and the runtime that builds `window.gugu` (`gugu-entry.ts`) turns it back
  // into an Error carrying `code`.
  throw { code: response.code, message: response.message, ...(response.detail ? { detail: response.detail } : {}) };
}

/*
 * Every event main sends this page, handed to its subscribers; a link or a banner click that opened this very page is held
 * for the first one (the preload runs before the page).
 */
const events = hostEventHub();
ipcRenderer.on(EXTENSION_BRIDGE_EVENT_CHANNEL, (_event: unknown, payload: ExtensionHostEvent) => events.deliver(payload));

/**
 * The members, from one table (`HOST_CALLS` / `HOST_EVENTS`): who has each is its `BRIDGE_VERBS` row (`only`) — the
 * background page is told so by main, and is drawn nowhere (no theme). The desktop answers every verb.
 */
const caller = process.argv.includes(BACKGROUND_PAGE_ARG) ? 'background' : 'page';
const members = hostMembers(caller, () => true, call, events.on);
const host = caller === 'background'
  ? { apiVersion: EXTENSION_API_VERSION, ...members }
  : {
      apiVersion: EXTENSION_API_VERSION,
      ...members,
      theme: readPageTheme(),
      /** Only on the page `app_check` runs (摩擦单 F69): the runtime reports its counts here. */
      ...(process.argv.includes(CHECK_PAGE_ARG) ? { checkPage: { report: (counts: PageCounts): Promise<void> => call('checkCounts', counts) as Promise<void> } } : {}),
    };

/*
 * The sync port: main creates it on this page's first `files.open` and posts it here; it
 * goes on into the page's own world, where the runtime runs the provider over it. Frames on
 * it are file sync traffic only — main checks every one against what this page was granted.
 */
// Held until the runtime says it listens (SYNC_PORT_REQUEST), then handed over — in either order.
// Posted any earlier, a port reaches a window with nobody listening and is gone (摩擦单 F28).
let heldPort: MessagePort | null = null;
let portWanted = false;
const handOverPort = () => {
  if (!heldPort || !portWanted) return;
  window.postMessage(SYNC_PORT_WINDOW_MESSAGE, '*', [heldPort]);
  heldPort = null;
};
ipcRenderer.on(SYNC_PORT_CHANNEL, (event) => {
  heldPort = event.ports[0] ?? null;
  handOverPort();
});
window.addEventListener('message', (event) => {
  if (event.source !== window || event.data !== SYNC_PORT_REQUEST) return;
  portWanted = true;
  handOverPort();
});

// A click on a link of gugu's own (`linkTo`'s) opens it, through the host, as that link from outside gugu would — the
// page itself may not navigate there (will-navigate keeps it on its own origin). Only a click the person made
// (`isTrusted`, and the gesture `call` checks); http(s) and the page's own links are left to what they did before.
const LEFT_ALONE = new Set(['http:', 'https:', 'about:', 'javascript:', 'data:', 'blob:', location.protocol]);
/** The clicked link, handed to the host: the gesture is checked in `call` like every gesture verb's. */
export function openClickedLink(url: string): Promise<unknown> {
  return call('openLink', { url });
}
window.addEventListener('click', (event) => {
  if (!event.isTrusted || event.defaultPrevented) return;
  const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!anchor || LEFT_ALONE.has(anchor.protocol)) return;
  event.preventDefault();
  void openClickedLink(anchor.href).catch((error: { message?: string }) => {
    void call('reportError', { message: error?.message ?? String(error) });
  });
}, true);

/**
 * The theme this page loads in (`EXTENSION_THEME_CHANNEL`), asked before its first line runs: the runtime puts it on
 * `<html>` before the first paint. Main always answers; anything else is the wiring broken — loud, like the host's own
 * system languages (preload.ts), never a quiet fall back to the OS's colours (the very flash this is here to stop).
 */
function readPageTheme(): 'light' | 'dark' {
  const answer: unknown = ipcRenderer.sendSync(EXTENSION_THEME_CHANNEL);
  if (answer !== 'light' && answer !== 'dark') throw new Error(`main did not answer ${EXTENSION_THEME_CHANNEL} (got ${String(answer)})`);
  return answer;
}

contextBridge.exposeInMainWorld('__guguHost', host);
