import { describe, expect, it, vi } from 'vitest';
import { EXTENSION_API_VERSION, parseExtensionManifest, safeParseExtensionManifest, type ExtensionManifest } from '@shared/extensions/manifest';
import { setSessionHostLocale } from '@main/core/host-locale';

// The host injects its language at boot (main.ts publishSessionHostLocale); a claimant names its App in it.
setSessionHostLocale('en-US');

/**
 * owner 10-17: a group file's mark is the icon the App that opens it declared for that kind of file (`fileIcons`, by the
 * claim that took it) — a markdown file drawn with the folder App's own icon read as a folder. A claim without one has no
 * icon (the page draws the generic glyph); the tab's own icon is never the answer. (Control: the parent commit, where the
 * `.json` row below carries the tab icon.)
 */

type Platform = { claimant(typedName: string): { suffix: string; app: { id: string; icon: string | null } } | null };
let platform: Platform | null = null;
const installed: { manifest: ExtensionManifest; rootDir: string }[] = [];

vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {} }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({ list: () => ({ extensions: installed }), isEnabled: () => true, openWithDefaults: () => ({}) }),
}));
vi.mock('@main/core/extensions/account-token', () => ({ currentAccountAccessToken: async () => null }));
vi.mock('@main/core/extensions/file-sync', () => ({ fileSync: {}, fileServiceUrl: () => 'http://files.invalid', localFileService: {} }));
vi.mock('@main/core/extensions/extension-icon', () => ({
  renderExtensionIcon: (rootDir: string, path: string) => ({ dataUrl: `png:${rootDir}/${path}` }),
}));
vi.mock('@shared/extensions/app-files-core', async (original) => ({
  ...(await original<typeof import('@shared/extensions/app-files-core')>()),
  createAppFiles: (given: Platform) => {
    platform = given;
    return {};
  },
}));

const manifest = (tab: Record<string, unknown>) => ({
  id: 'workspace',
  name: '文件夹',
  version: '1.0.0',
  apiVersion: EXTENSION_API_VERSION,
  entry: 'index.html',
  contributes: { tabs: [{ name: 'main', title: '文件夹', icon: 'icon.png', opensFiles: { chat: ['.md', '.json'] }, ...tab }] },
});

installed.push({ rootDir: '/apps/workspace', manifest: parseExtensionManifest(manifest({ fileIcons: { '.md': 'md.png' } })) });
await import('./app-files');
const iconOf = (name: string) => platform!.claimant(name)?.app.icon;

describe('a group file\'s icon: the one its App declared for its kind (owner 10-17)', () => {
  it('a declared kind: that icon, re-encoded from the App\'s folder', () => {
    expect(iconOf('notes.md')).toBe('png:/apps/workspace/md.png');
  });

  it('a claimed kind with no icon declared: none — never the tab\'s own icon', () => {
    expect(platform!.claimant('cfg.json')?.app.id).toBe('workspace');
    expect(iconOf('cfg.json')).toBe(null);
  });

  it('a key is read as a claim is: trimmed and lowercased', () => {
    const parsed = parseExtensionManifest(manifest({ opensFiles: { chat: ['.MD'] }, fileIcons: { ' .MD': 'md.png' } }));
    expect(parsed.contributes.tabs[0]!.fileIcons).toEqual({ '.md': 'md.png' });
  });

  it('fileIcons keyed by anything but this tab\'s claims is refused, naming them', () => {
    const parsed = safeParseExtensionManifest(manifest({ fileIcons: { '.csv': 'csv.png' } }));
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.issues.join('\n')).toContain('".csv" is not one of this tab\'s opensFiles claims (.md, .json)');
  });
});
