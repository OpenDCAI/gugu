import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import { extensionsService } from '@main/core/extensions/extensions-root';
import type { ExtensionsService } from '@main/core/extensions/extensions-service';
import { log } from '@main/lib/logger';

/**
 * Apps that ship inside gugu — the workspace first (真源 §2.6: 工作区是一个预装 App). They are
 * ordinary Apps written against the public API only; what makes them preinstalled is where they
 * come from and who installs them:
 *
 * - **Where**: `apps/desktop/preinstalled-apps/<id>/` in the repo, `Resources/preinstalled-apps/` in a
 *   package (electron-builder.cjs). A gugu server is the desktop without a window and gets every one of
 *   them: its package carries the folder at `app/apps/desktop/preinstalled-apps/` (build-gugu-server.mjs),
 *   which is where the unpackaged path resolves there. `GUGU_PREINSTALLED_APPS_DIR` overrides all for tests.
 * - **Who**: gugu, at every start (embedded-boot.ts), with origin `preinstalled` — the bytes installed
 *   are the bytes this build shipped, so an update of gugu is an update of its Apps, and a
 *   folder edited in dev shows up on the next start. No consent dialog: what a preinstalled App may
 *   do was reviewed with gugu itself.
 * - **Never removed**: uninstall and switch-off refuse (extensions-service.ts), and no other
 *   package may take its id.
 * - **Until gugu stops shipping it**: one installed as preinstalled that this build no longer carries is left where it is
 *   and becomes the person's, an ordinary market App (`releasePreinstalled`) — it can then be switched off, uninstalled
 *   and updated from the market. Which ones is read from the record, never named here.
 */
export const PREINSTALLED_APPS_RESOURCE_DIR = 'preinstalled-apps';

export function preinstalledAppsRoot(): string {
  const override = process.env.GUGU_PREINSTALLED_APPS_DIR;
  if (override) return override;
  return app.isPackaged
    ? path.join(process.resourcesPath, PREINSTALLED_APPS_RESOURCE_DIR)
    : path.join(app.getAppPath(), 'apps', 'desktop', PREINSTALLED_APPS_RESOURCE_DIR);
}

export interface PreinstalledAppsReport {
  installed: string[];
  /** Directories that did not install; why is in the log (the error text is for whoever debugs it). */
  failed: string[];
  /** The folder looked in, when it is not there: this build shipped no Apps. */
  missing: string | null;
  /** Installed as preinstalled by an earlier build, not shipped by this one: now the person's market Apps. */
  released: string[];
}

/**
 * Installs every preinstalled App from `root`, replacing whatever copy is there, and makes sure it is
 * on; then releases each one recorded as preinstalled that `root` no longer carries. One App failing is
 * reported and does not stop the others.
 */
export function ensurePreinstalledApps(
  service: Pick<ExtensionsService, 'inspectDirectory' | 'installFromDirectory' | 'isEnabled' | 'setEnabled' | 'origins' | 'releasePreinstalled'> = extensionsService(),
  root: string = preinstalledAppsRoot(),
): PreinstalledAppsReport {
  const report: PreinstalledAppsReport = { installed: [], failed: [], missing: null, released: [] };
  if (!fs.existsSync(root)) {
    // A build without the folder is a broken build, not one that stopped shipping its Apps: nothing is released.
    log.error('extensions: the preinstalled Apps folder is missing, so none are installed', { root });
    return { ...report, missing: root };
  }
  // What this build carries, by id — a folder that does not install this time still counts by its name: it is shipped.
  const shipped = new Set<string>();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(root, entry.name);
    shipped.add(entry.name);
    try {
      const { manifest, manifestDigest } = service.inspectDirectory(dir);
      shipped.add(manifest.id);
      service.installFromDirectory(dir, manifestDigest, 'preinstalled');
      if (!service.isEnabled(manifest.id)) service.setEnabled(manifest.id, true);
      report.installed.push(manifest.id);
    } catch (error) {
      report.failed.push(entry.name);
      log.error('extensions: a preinstalled App could not be installed', { dir: entry.name, error });
    }
  }
  for (const [id, origin] of Object.entries(service.origins())) {
    if (origin !== 'preinstalled' || shipped.has(id)) continue;
    try {
      service.releasePreinstalled(id);
      report.released.push(id);
      log.info('extensions: a preinstalled App this build no longer ships is now a market App', { id });
    } catch (error) {
      report.failed.push(id);
      log.error('extensions: a preinstalled App this build no longer ships could not be released', { id, error });
    }
  }
  return report;
}
