import * as path from 'node:path';
import { app } from 'electron';
import { ExtensionsService } from './extensions-service';
import { extensionDataDir } from './extension-data';

/**
 * Where installed task extensions live on this machine, and the app-wide
 * service reading that directory. Kept apart from extensions-service.ts so the
 * service itself stays free of electron and unit-testable against a temp dir.
 *
 * Resolution is lazy on purpose: the host repoints userData during
 * [APP-BOOTSTRAP] (see embedded-boot.ts), so reading it at module load would
 * capture the pre-repoint path. Refs #2374.
 */

export const EXTENSIONS_DIR_NAME = 'task-extensions';

export function extensionsRoot(): string {
  return path.join(app.getPath('userData'), EXTENSIONS_DIR_NAME);
}

/**
 * 摩擦单 F81 (S23: `?? kanban-app/` in the person's repository) Where `app_create` writes an App's source when the
 * agent names no folder: this computer's own, outside every working copy — one folder per App id.
 */
export const APP_SOURCES_DIR_NAME = 'app-sources';

export function appSourcesRoot(): string {
  return path.join(app.getPath('userData'), APP_SOURCES_DIR_NAME);
}

/** #6387 The folder an extension's pages and its MCP programs share. */
export function extensionDataRoot(extensionId: string): string {
  return extensionDataDir(app.getPath('userData'), extensionId);
}

let service: ExtensionsService | null = null;

export function extensionsService(): ExtensionsService {
  service ??= new ExtensionsService(extensionsRoot());
  return service;
}
