import { session, webContents, type Session } from 'electron';
import { log } from '@main/lib/logger';
import { extensionPartition } from '@shared/extensions/partition';
import {
  applyExtensionCorsGrant,
  decideExtensionRequest,
  extensionCorsRequest,
  type ExtensionCorsRequest,
} from './extension-network-policy';
import {
  setupExtensionProtocol,
  teardownExtensionProtocol,
  type ExtensionBundle,
} from './extension-protocol';

/**
 * The session behind one extension's sandbox: its own partition, its own
 * storage, and a network layer that only lets through the hosts its manifest
 * declared. A page cannot lift this — unlike the CSP it is served with, which
 * exists so the author sees the same rule as an error rather than a silence.
 * Refs #2374.
 */

/** Web permissions an extension may use unasked. Everything else is denied. */
const ALLOWED_EXTENSION_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write']);

type ConfiguredExtension = {
  session: Session;
  /**
   * Replaced whenever the extension is reinstalled, upgraded, or its grants
   * change. Everything below reads it live rather than capturing it, so a
   * session that outlives one version does not keep enforcing that version's
   * rules or serving its files.
   */
  bundle: ExtensionBundle;
};

const configured = new Map<string, ConfiguredExtension>();

/**
 * Returns the session for an extension, hardening it exactly once per
 * partition. Call again after its granted hosts change: the new list replaces
 * the old one on the live session.
 */
export function configureExtensionSession(bundle: ExtensionBundle): Session {
  const { extensionId } = bundle;
  const existing = configured.get(extensionId);
  if (existing) {
    existing.bundle = bundle;
    return existing.session;
  }

  const partition = extensionPartition(extensionId);
  const ses = session.fromPartition(partition);
  const entry: ConfiguredExtension = { session: ses, bundle };
  configured.set(extensionId, entry);

  // Serving the bundle is per-session: a handler on the default session would
  // never be consulted by a webview running on this partition.
  setupExtensionProtocol(ses, () => entry.bundle);

  ses.webRequest.onBeforeRequest((details, callback) => {
    const decision = decideExtensionRequest(details.url, entry.bundle.networkHosts);
    if (decision.allowed) {
      callback({ cancel: false });
      return;
    }
    log.warn('Blocked extension network request', {
      extensionId,
      reason: decision.reason,
      url: redactUrl(details.url),
    });
    callback({ cancel: true });
  });

  const corsRequests = new Map<number, ExtensionCorsRequest>();

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const corsRequest = extensionCorsRequest(details.requestHeaders, extensionId);
    if (corsRequest) corsRequests.set(details.id, corsRequest);
    else corsRequests.delete(details.id);
    callback({ requestHeaders: details.requestHeaders });
  });

  ses.webRequest.onHeadersReceived((details, callback) => {
    const corsRequest = corsRequests.get(details.id);
    corsRequests.delete(details.id);
    if (!corsRequest || !details.responseHeaders) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({ responseHeaders: applyExtensionCorsGrant(details.responseHeaders, corsRequest) });
  });

  ses.webRequest.onCompleted((details) => corsRequests.delete(details.id));
  ses.webRequest.onErrorOccurred((details) => corsRequests.delete(details.id));

  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    const granted = ALLOWED_EXTENSION_PERMISSIONS.has(permission);
    if (!granted) log.debug('Denied extension permission request', { extensionId, permission });
    callback(granted);
  });
  ses.setPermissionCheckHandler((_webContents, permission) =>
    ALLOWED_EXTENSION_PERMISSIONS.has(permission)
  );

  return ses;
}

/** Partitions hardened in this run — the attach gate admits no others. */
export function configuredExtensionIds(): ReadonlySet<string> {
  return new Set(configured.keys());
}

/**
 * The extension a webContents belongs to, by session identity rather than by
 * URL: a webContents reports its session the moment it attaches, while its URL
 * may still be empty that early.
 */
export function extensionIdForSession(candidate: Session): string | null {
  for (const [extensionId, entry] of configured) {
    if (entry.session === candidate) return extensionId;
  }
  return null;
}

/**
 * Drops an uninstalled extension's storage. Uninstalling removes the bundle;
 * leaving its cookies and localStorage behind would mean a reinstall silently
 * inherits state the user believed they had removed.
 */
export async function clearExtensionSessionData(extensionId: string): Promise<void> {
  const entry = configured.get(extensionId);
  const ses = entry?.session ?? session.fromPartition(extensionPartition(extensionId));
  configured.delete(extensionId);
  // The session object outlives this call — fromPartition hands the same one
  // back on reinstall — so the handler has to come off with the entry it reads.
  // Left registered, it would keep serving the uninstalled bundle's directory
  // and CSP to whatever gets installed next.
  teardownExtensionProtocol(ses);
  await ses.clearStorageData();
  await ses.clearCache();
}

/** Whether this extension's session was hardened in this run. */
export function isExtensionSessionConfigured(extensionId: string): boolean {
  return configured.has(extensionId);
}

/**
 * Reloads every open surface of one extension.
 *
 * The request filter is live — it reads the current grant list per request — but
 * the CSP is not: it is a response header, stamped when the document loaded. So
 * after a grant changes, an already-open surface keeps a header naming a host
 * the session now blocks, which is the header/enforcement disagreement this
 * design exists to avoid. Reloading is what makes the two agree again; the
 * surface has to re-render anyway, since what it was reading just went away.
 */
export function reloadExtensionSurfaces(extensionId: string): void {
  const entry = configured.get(extensionId);
  if (!entry) return;
  for (const contents of webContents.getAllWebContents()) {
    if (contents.session !== entry.session || contents.isDestroyed()) continue;
    contents.reloadIgnoringCache();
  }
}

/** Query strings can carry search terms and tokens; the host and path are enough to debug with. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '<unparsable>';
  }
}
