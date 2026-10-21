import { extensionIdFromPartition, extensionIdFromUrl } from '@shared/extensions/partition';
import type { WebviewAttachParams, WebviewPreferences } from '@main/core/browser/webview-security';

/**
 * Admission gate for extension <webview> attachments. Deliberately separate
 * from the browser gate: relaxing that one to also admit extensions would make
 * a single predicate answer two different questions, and any later change to
 * either would silently move the other. Refs #2374.
 */

export type ExtensionAttachValidation =
  | { ok: true; extensionId: string; partition: string; url: string }
  | {
      ok: false;
      reason:
        | 'not-extension-partition'
        | 'unconfigured-extension'
        | 'not-extension-url'
        | 'cross-extension-url';
    };

/**
 * An attachment is admitted only when the partition names an extension whose
 * session has been hardened, and the page it loads belongs to that same
 * extension. Default is refusal: an unrecognised attachment never renders.
 */
export function validateExtensionWebviewAttach(
  params: WebviewAttachParams,
  configuredExtensionIds: ReadonlySet<string>
): ExtensionAttachValidation {
  const partition = typeof params.partition === 'string' ? params.partition : '';
  const extensionId = extensionIdFromPartition(partition);
  if (!extensionId) return { ok: false, reason: 'not-extension-partition' };
  if (!configuredExtensionIds.has(extensionId)) {
    return { ok: false, reason: 'unconfigured-extension' };
  }

  const src = typeof params.src === 'string' ? params.src : '';
  const urlExtensionId = extensionIdFromUrl(src);
  if (!urlExtensionId) return { ok: false, reason: 'not-extension-url' };
  if (urlExtensionId !== extensionId) return { ok: false, reason: 'cross-extension-url' };

  return { ok: true, extensionId, partition, url: src };
}

/**
 * Locks an extension webview to the same footing as the embedded browser: no
 * node, isolated context, OS sandbox on, web security enforced.
 *
 * `preload` is deleted rather than trusted. A preload runs with more authority
 * than the page, so which script that is must be the main process's decision;
 * a renderer-supplied path would let the renderer choose the extension's
 * powers. When the bridge lands, main sets this field itself, after this call.
 */
/**
 * Blink features an extension surface is built without. Names are Chromium's
 * runtime-enabled-feature names; a wrong one is a silent no-op, which is why the
 * hostile fixture reports whether the API is actually gone (`fs-picker`).
 */
const BLOCKED_BLINK_FEATURES = 'FileSystemAccess,FileSystemAccessLocal';

export function hardenExtensionWebviewPreferences(webPreferences: WebviewPreferences): void {
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.nodeIntegrationInWorker = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
  // An extension that could embed its own <webview> would pick the partition:
  // naming a browser profile's would put the user's signed-in sessions inside
  // the sandbox. Nesting is not a capability any extension declared.
  webPreferences.webviewTag = false;
  // Reaching anything outside the task's own worktree is supposed to go through
  // the host's selector, so the host knows what was handed over. The File System
  // Access API is the extension's own selector: it does not pass through Electron's
  // permission handler at all (only restricted paths raise an event), and the grant
  // it produces persists in the extension's origin, invisible to the host. So the
  // capability is removed rather than denied per call — 没声明的能力就是没有.
  webPreferences.disableBlinkFeatures = [webPreferences.disableBlinkFeatures, BLOCKED_BLINK_FEATURES]
    .filter(Boolean)
    .join(',');
  delete webPreferences.preload;
}

/**
 * Whether an extension surface may navigate itself to `url`.
 *
 * Only within its own bundle. The CSP that pins code to the bundle rides
 * gugu-ext:// responses, so a top-level navigation to a declared host — which
 * the network allowlist would permit for a fetch — would land the surface on a
 * remote origin with no such header, and remote script would run in it. Fetching
 * from a declared host and *becoming* it are different acts.
 */
export function isAllowedExtensionNavigation(url: string, extensionId: string): boolean {
  return extensionIdFromUrl(url) === extensionId;
}

export function stripExtensionWebviewParams(params: WebviewAttachParams): void {
  delete params.preload;
}
