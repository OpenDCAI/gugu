import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_API_VERSION, parseExtensionManifest, type ExtensionManifest } from '@shared/extensions/manifest';
import { setSessionHostLocale } from '@main/core/host-locale';

// The host injects its language at boot (main.ts publishSessionHostLocale); a claimant names its App in it.
setSessionHostLocale('en-US');

/**
 * 摩擦单 F87 (L4's Electron cell, 07:25): the list the install's resync asked for still named the old claimant — main
 * kept the enabled Apps for a second, and a listing within that second of the install read the copy from before it.
 * Nothing asked again, so the row kept its raw name. The enabled Apps are now read once per listing pass, never kept
 * past it. (Control: the parent commit, where the second listing below names `workspace`.)
 */

type Platform = { claimant(typedName: string): { suffix: string; app: { id: string } } | null };
let platform: Platform | null = null;
const installed: { manifest: ExtensionManifest; rootDir: string }[] = [];
const list = vi.fn(() => ({ extensions: installed }));

vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {} }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({ list, isEnabled: () => true, openWithDefaults: () => ({}) }),
}));
vi.mock('@main/core/extensions/account-token', async (importOriginal) => ({ ...(await importOriginal<object>()), currentAccountAccessToken: async () => null }));
vi.mock('@main/core/extensions/file-sync', () => ({ fileSync: {}, fileServiceUrl: () => 'http://files.invalid', localFileService: {} }));
vi.mock('@main/core/extensions/extension-icon', () => ({ renderExtensionIcon: () => null }));
vi.mock('@shared/extensions/app-files-core', async (original) => ({
  ...(await original<typeof import('@shared/extensions/app-files-core')>()),
  createAppFiles: (given: Platform) => {
    platform = given;
    return {};
  },
}));

function app(id: string, claims: string[]) {
  return {
    rootDir: `/apps/${id}`,
    manifest: parseExtensionManifest({
      id,
      name: id,
      version: '1.0.0',
      apiVersion: EXTENSION_API_VERSION,
      entry: 'index.html',
      contributes: { tabs: [{ name: 'main', title: id, opensFiles: { chat: claims } }] },
    }),
  };
}

await import('./app-files');
const claimedBy = (name: string) => platform!.claimant(name)?.app.id ?? null;
const nextListing = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  installed.splice(0, installed.length, app('workspace', ['.json']));
  list.mockClear();
});

describe('who a listed group file belongs to, right after an install (摩擦单 F87)', () => {
  it('the listing right after the install names the new App — however soon after the last one', async () => {
    expect(claimedBy('guess.draw-guess.json')).toBe('workspace');
    await nextListing();
    installed.push(app('draw-guess', ['.draw-guess.json']));
    // Well within a second of the listing above: the list the install's resync asks for.
    expect(claimedBy('guess.draw-guess.json')).toBe('draw-guess');
  });

  it('one listing of a hundred rows reads the installed Apps once', () => {
    for (let row = 0; row < 100; row += 1) claimedBy(`file-${row}.json`);
    expect(list).toHaveBeenCalledTimes(1);
  });
});
