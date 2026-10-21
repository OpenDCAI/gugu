import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// A gugu server runs this same main with `electron` pinned to the headless shim (server = the desktop without a window).
vi.mock('electron', async () => await import('../../../headless/electron-shim'));

const { renderExtensionIcon } = await import('./extension-icon');

/**
 * Every `gugu.files` listing names the App that opens each row, with its icon (app-files.ts). On a gugu server that icon
 * went through a shim image without `resize`, so the listing threw `image.resize is not a function` — after the work
 * was done (a create had already made its file).
 */
describe('an App icon on a gugu server (headless electron shim)', () => {
  it('falls back to the generic mark instead of throwing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gugu-icon-headless-'));
    const png = readFileSync(fileURLToPath(new URL('../../../../../preinstalled-apps/workspace/icon.png', import.meta.url)));
    expect(png.length).toBeGreaterThan(0);
    writeFileSync(path.join(dir, 'icon.png'), png);
    expect(renderExtensionIcon(dir, 'icon.png')).toEqual({ reason: 'icon could not be re-encoded' });
  });
});
