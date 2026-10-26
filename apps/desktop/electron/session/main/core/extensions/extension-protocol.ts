import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, type Session } from 'electron';
import { EXTENSION_SCHEME, extensionIdFromUrl } from '@shared/extensions/partition';
import { APP_RUNTIME_PREFIX, injectAppRuntime } from '@shared/extensions/app-runtime-protocol';
import { extensionContentSecurityPolicy } from '@shared/extensions/app-csp';
import { appRuntimeDir } from '@main/core/extensions/app-runtime-dir';

/**
 * Serves one installed extension's bundle over gugu-ext://<extensionId>/<path>.
 *
 * Own scheme rather than file:// for two reasons: each extension gets a
 * distinct secure origin (its storage is its own, and CSP can be pinned to
 * it), and module scripts are silently refused under file://. Refs #2374.
 */

/** What serving an extension needs. Read per request — see setupExtensionProtocol. */
export interface ExtensionBundle {
  extensionId: string;
  /** Absolute path of the installed bundle directory. */
  rootDir: string;
  /** Hosts the manifest declared, mirrored into the served CSP. */
  networkHosts: readonly string[];
}

/**
 * Installs the gugu-ext handler on one extension's session.
 *
 * Protocol handlers are per-session, and every extension renders on its own
 * partition — a handler on the default session would never be consulted by the
 * surface this exists for. Registering the scheme as *privileged* is separate
 * and must happen before app ready, which is the host's phase: gugu's main.ts
 * does it (@@@2374-ext-scheme) from this same EXTENSION_SCHEME constant.
 *
 * ⚠️ The bundle arrives as a getter, not a value, and every response reads it
 * afresh. A session outlives the bundle it was first configured with: upgrading
 * replaces the directory on disk, and revoking a permission shortens the host
 * list. A handler that closed over the first bundle would keep serving the
 * *previous* version's files, and keep stamping the previous version's CSP —
 * so a newly consented host would be permitted by the session filter and
 * refused by the header, which is the one contradiction this header exists to
 * avoid. Registration itself stays once per session (`protocol.handle` replaces
 * nothing and throws on a second call).
 */
export function setupExtensionProtocol(
  session: Pick<Session, 'protocol'>,
  currentBundle: () => ExtensionBundle,
  fetchFile: (file: string) => Promise<Response> = (file) => net.fetch(pathToFileURL(file).toString()),
): void {
  const { protocol } = session;
  if (protocol.isProtocolHandled(EXTENSION_SCHEME)) return;

  protocol.handle(EXTENSION_SCHEME, async (request) => {
    const bundle = currentBundle();
    const csp = extensionContentSecurityPolicy(
      `${EXTENSION_SCHEME}://${bundle.extensionId}`,
      bundle.networkHosts
    );

    // The session belongs to one extension, so a request naming another is a
    // page reaching across the boundary the partition exists to draw.
    if (extensionIdFromUrl(request.url) !== bundle.extensionId) {
      return new Response('forbidden', { status: 403, headers: { 'Content-Security-Policy': csp } });
    }

    const pathname = new URL(request.url).pathname;
    // The platform runtime: gugu's own files, whatever the bundle holds (a bundle may not
    // ship `_gugu/` at all — refused at install — so nothing is being shadowed).
    const fromRuntime = pathname.startsWith(APP_RUNTIME_PREFIX);
    const root = fromRuntime ? appRuntimeDir() : bundle.rootDir;
    if (!root) {
      return new Response('the App runtime is missing from this build', {
        status: 500,
        headers: { 'Content-Security-Policy': csp },
      });
    }
    const resolved = resolveBundleFile(root, fromRuntime ? pathname.slice(APP_RUNTIME_PREFIX.length) : pathname);
    // Outside the bundle, and also a file it does not have: a missing file has no real path to check, so it is 403
    // here, not the 404 below.
    if (!resolved) {
      return new Response('forbidden', { status: 403, headers: { 'Content-Security-Policy': csp } });
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      // A directory (or a file gone since the line above): answer rather than let net.fetch reject,
      // which would surface as a network error with no status at all.
      return new Response('not found', { status: 404, headers: { 'Content-Security-Policy': csp } });
    }

    const response = await fetchFile(resolved);
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', csp);
    // An App document gets the runtime's script tag first (`injectAppRuntime`), the same
    // line the mobile host adds — so `window.gugu` is there on the App's first line. Read
    // through the same fetch as every other file: one way files leave the bundle.
    if (!fromRuntime && /\.html?$/i.test(resolved)) {
      headers.set('Content-Type', 'text/html; charset=utf-8');
      headers.delete('Content-Length');
      return new Response(injectAppRuntime(await response.text()), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });
}

/**
 * Removes the handler when an extension is uninstalled.
 *
 * Without this, a reinstall in the same run is served by the *previous*
 * registration: `session.fromPartition` hands back the same live Session, so
 * `isProtocolHandled` is still true and setup returns early — leaving a handler
 * closed over the dead bundle, stamping the old version's CSP onto the new
 * version's files while the session filter enforces the new host list. That is
 * exactly the header/enforcement contradiction the getter exists to prevent.
 */
export function teardownExtensionProtocol(session: Pick<Session, 'protocol'>): void {
  if (!session.protocol.isProtocolHandled(EXTENSION_SCHEME)) return;
  session.protocol.unhandle(EXTENSION_SCHEME);
}

/**
 * Maps a URL path to a file inside the bundle, or null if it leaves it.
 *
 * Containment is checked against the real path, so a symlink planted in a
 * bundle cannot be used to read something outside it: a lexical check passes
 * for `<bundle>/notes` no matter where `notes` actually points.
 */
function resolveBundleFile(rootDir: string, pathname: string): string | null {
  const relativePath = decodeURIComponent(pathname).replace(/^\/+/, '');
  const resolved = path.resolve(rootDir, relativePath);
  const realRoot = realPathOrNull(rootDir);
  const realTarget = realPathOrNull(resolved);
  if (!realRoot || !realTarget) return null;
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) return null;
  return resolved;
}

function realPathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}
