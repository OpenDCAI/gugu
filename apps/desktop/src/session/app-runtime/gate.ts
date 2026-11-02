import { APP_FRAME_MARKER } from '@shared/extensions/app-runtime-protocol';

/**
 * @@@app-gate - The phone's gate: the one page the shell serves in an App's gate origin, https://<appId>.gate.gugu.invalid
 * (appOrigin.ts `gateOrigin`, AppOrigins.java), from this build — never from an App's package. The gugu page frames the
 * gate; the gate frames the App's page in the App's own origin, and passes every message between the two unchanged but
 * one thing: each call the App makes leaves here stamped with the gate's own activation.
 *
 * Why the gate's activation is the gesture: the browser tells a frame's ancestors of the person's input in it (a tap, a
 * key) and nobody else — not frames below the page that was touched, not frames of another origin beside it (measured
 * 11-02 on Chrome 147 and Android WebView 113 and 133: tap the page, tap App A, read both gates). So it is active
 * exactly when the person's input landed in this App, within the activation's lifetime. The gugu page's own activation is any tap anywhere on the phone's screen; the
 * App's is its own script's word. Neither reaches the gate: it is another origin than both, and a sandboxed frame cannot
 * navigate its parent.
 */
export function startGate(win: Window, at: Pick<Location, 'origin' | 'search'> = win.location): HTMLIFrameElement {
  const appOrigin = at.origin.replace('.gate.gugu.invalid', '.apps.gugu.invalid');
  if (appOrigin === at.origin) throw new Error(`the gate runs only in an App's gate origin, not ${at.origin}`);
  const page = new URL(new URLSearchParams(at.search).get('page') ?? '', `${appOrigin}/`);
  if (page.origin !== appOrigin) throw new Error(`the gate frames only its own App's pages, not ${page.href}`);

  const document = win.document;
  const frame = document.createElement('iframe');
  // What the gugu page named this frame is the App's (APP_SESSION_FRAME_NAME: the page is in a session).
  frame.name = win.name;
  // The gugu page's sandbox is on the gate already and goes down to this frame with it; said again so it never depends on that.
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
  frame.src = page.href;
  frame.style.cssText = 'display:block;width:100%;height:100%;border:0';
  document.documentElement.style.cssText = document.body.style.cssText = 'margin:0;width:100%;height:100%;overflow:hidden';
  document.body.append(frame);
  // The gugu page focuses the gate (a modal's first field): the focus goes on to the App.
  win.addEventListener('focus', () => frame.focus());

  win.addEventListener('message', (event) => {
    const ports = [...event.ports];
    if (event.source === win.parent) {
      frame.contentWindow?.postMessage(event.data, appOrigin, ports);
      return;
    }
    // Only the App's own document: another frame that got hold of this window has nothing to say through it.
    if (event.source !== frame.contentWindow || event.origin !== appOrigin) return;
    const message = event.data as { m?: unknown; t?: unknown } | null;
    // @@@gate-stamp - the gate's reading, over whatever the App wrote: the one fact the gugu page takes from here.
    const out = message && message.m === APP_FRAME_MARKER && message.t === 'call'
      ? { ...message, gesture: win.navigator.userActivation?.isActive === true }
      : event.data;
    win.parent.postMessage(out, '*', ports);
  });
  return frame;
}
