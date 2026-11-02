import { isValidExtensionId } from '../../session/shared/extensions/manifest'

/**
 * Where an App runs on the phone (L9, 摩擦单 F76): an origin of its own — https://<appId>.apps.gugu.invalid — the
 * shape AppOrigins.java answers. Whoever is signed in, as the desktop's partition (主人 10-01).
 *
 * Why this is what makes the frame safe: the App's iframe is `sandbox="allow-scripts allow-same-origin"`, and
 * allow-same-origin is only harmless because the App's origin is never the gugu page's own (https://localhost) — a frame
 * the same origin as its parent could lift its own sandbox and reach the page's credentials. So the origin is always
 * under a top-level domain that never resolves (only the shell answers there), and always the App's (another App's
 * storage is another origin's).
 */
export const APPS_DOMAIN = 'apps.gugu.invalid'

export function appOrigin(appId: string): string {
  if (!isValidExtensionId(appId)) throw new Error(`not an App id: ${appId}`)
  return `https://${appId}.${APPS_DOMAIN}`
}

/**
 * @@@app-gate - Where an App's gate runs (gate.ts): a third origin of the App's own, https://<appId>.gate.gugu.invalid,
 * which the shell answers with gugu's gate page and nothing else (AppOrigins.java). Every App frame on this page is drawn
 * inside its gate. The browser tells a frame's ancestors of the person's input in it and nobody else — not another App's
 * frames, not frames below the page that was touched — so the gate's own activation is exactly "the person's input landed
 * in this App", which neither this page's (any tap anywhere) nor the App's (its own script reports it) can be.
 */
export const GATES_DOMAIN = 'gate.gugu.invalid'

export function gateOrigin(appId: string): string {
  if (!isValidExtensionId(appId)) throw new Error(`not an App id: ${appId}`)
  return `https://${appId}.${GATES_DOMAIN}`
}

/** As much of an iframe as talking to it takes. */
type AppFrame = Pick<HTMLIFrameElement, 'src'> & { readonly contentWindow: Pick<Window, 'postMessage'> | null }

/**
 * Messages between this page and an App's frame (L3 review): only ever with the document of the origin its `src` names —
 * the App's gate for a page of the App (which passes them on to the App's own document), the App's origin for the forget page. What goes in carries the file bytes (the sync port) and the answers of the host; a frame whose
 * document is anything else (were a navigation ever to get past the shell's rule) is given nothing — the browser drops a
 * message whose target origin is not the document's — and is not listened to.
 */
export function appFrameChannel(frame: AppFrame) {
  const origin = (): string | null => {
    try {
      return new URL(frame.src).origin
    } catch {
      return null
    }
  }
  return {
    /** To the App's document, with what it hands over (a port); false when there is no App document to name. */
    post(message: unknown, transfer: Transferable[] = []): boolean {
      const target = frame.contentWindow
      const to = origin()
      if (!target || !to || to === 'null') return false
      target.postMessage(message, to, transfer)
      return true
    },
    /** From the App's document: its window, and its origin. */
    accepts(event: Pick<MessageEvent, 'source' | 'origin'>): boolean {
      return event.source !== null && event.source === frame.contentWindow && event.origin === origin()
    },
  }
}
