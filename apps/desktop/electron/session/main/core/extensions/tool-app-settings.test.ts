import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXTENSION_API_VERSION, parseExtensionManifest, safeParseExtensionManifest } from '@shared/extensions/manifest';
import { resolveAppSettings } from '@shared/extensions/app-settings';
import { ExtensionsService } from './extensions-service';
import { scaffoldExtension } from './extension-authoring';

const raw = {
  id: 'tool-app', name: 'Tool App', version: '1.0.0', apiVersion: 5,
  permissions: { capabilities: ['agents:tools'] },
  contributes: { mcpServers: [{ tools: 'tools.js' }] },
  settings: [
    { key: 'account', title: 'Account', type: 'string', default: 'personal' },
    { key: 'enabled', title: 'Enabled', type: 'boolean', default: true },
    { key: 'mode', title: 'Mode', type: 'select', options: [{ value: 'local', title: 'Local' }, { value: 'remote', title: 'Remote' }], default: 'local' },
  ],
};
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const work = () => { const dir = mkdtempSync(join(tmpdir(), 'gugu-tool-app-')); dirs.push(dir); return dir; };

describe('tool App host pages and settings', () => {
  it('accepts a native host program without inventing HTML or an executable file', () => {
    const manifest = parseExtensionManifest({ ...raw, contributes: { mcpServers: [{ name: 'browser-use', host: 'browser-use' }] } });
    expect(manifest.contributes.mcpServers).toEqual([{ name: 'browser-use', host: 'browser-use' }]);
    expect(manifest.contributes.tabs[0]?.hostPage).toBe('settings');
    expect(safeParseExtensionManifest({ ...raw, apiVersion: 4, contributes: { mcpServers: [{ name: 'browser-use', host: 'browser-use' }] } }).ok).toBe(false);
    expect(safeParseExtensionManifest({ ...raw, contributes: { mcpServers: [{ name: 'desktop', host: 'arbitrary-host' }] } }).ok).toBe(false);
  });
  it('creates and installs a real tools-only bundle with a host page and no HTML', () => {
    const dir = work();
    const { sourceDir, manifest } = scaffoldExtension({ targetDir: join(dir, 'source'), manifest: { ...raw, apiVersion: EXTENSION_API_VERSION, platforms: ['desktop'] },
      files: { 'tools.js': 'export const hello = {run: async () => ({content: []})};' } });
    expect(manifest.entry).toBeUndefined();
    expect(manifest.contributes.tabs).toEqual([{ name: 'settings', title: 'Settings', hostPage: 'settings' }]);
    expect(parseExtensionManifest(JSON.parse(readFileSync(join(sourceDir, 'manifest.json'), 'utf8')))).toEqual(manifest);
    const service = new ExtensionsService(join(dir, 'installed'));
    const inspected = service.inspectDirectory(sourceDir);
    service.installFromDirectory(sourceDir, inspected.manifestDigest, 'folder');
    expect(service.list().invalid).toEqual([]);
    expect(service.settings(raw.id)).toEqual({ account: 'personal', enabled: true, mode: 'local' });
    service.setDock([raw.id]);
    expect(service.dock()).toEqual([raw.id]);
  });

  it('rejects a tool manifest with missing permission, a blank App, an invalid HTML tab and an older API', () => {
    expect(safeParseExtensionManifest({ ...raw, permissions: {} }).ok).toBe(false);
    expect(safeParseExtensionManifest({ ...raw, contributes: {} }).ok).toBe(false);
    expect(safeParseExtensionManifest({ ...raw, contributes: { ...raw.contributes, tabs: [{ name: 'main', title: 'Main' }] } }).ok).toBe(false);
    expect(safeParseExtensionManifest({ ...raw, apiVersion: 4 }).ok).toBe(false);
    expect(safeParseExtensionManifest({ ...raw, id: 'invalid.id' }).ok).toBe(false);
    expect(safeParseExtensionManifest({ ...raw, apiVersion: 999 }).ok).toBe(false);
  });

  it('keeps existing HTML Apps and mixed custom/host pages working', () => {
    const legacy = { id: 'legacy-app', name: 'Legacy', version: '1.0.0', apiVersion: 3, entry: 'main.html',
      contributes: { tabs: [{ name: 'main', title: 'Main' }] } };
    expect(parseExtensionManifest(legacy)).toMatchObject(legacy);
    expect(parseExtensionManifest({ ...raw, entry: 'main.html', contributes: { ...raw.contributes,
      tabs: [{ name: 'main', title: 'Main' }, { name: 'settings', title: 'Settings', hostPage: 'settings' }] } }).contributes.tabs).toHaveLength(2);
  });

  it('validates declared keys, value types, select options and defaults', () => {
    const manifest = parseExtensionManifest(raw);
    expect(resolveAppSettings(manifest, { account: 'work', enabled: false, mode: 'remote' })).toEqual({ account: 'work', enabled: false, mode: 'remote' });
    for (const values of [{ unknown: 'x' }, { enabled: 'false' }, { mode: 'other' }, [], null]) {
      expect(() => resolveAppSettings(manifest, values)).toThrow();
    }
    expect(safeParseExtensionManifest({ ...raw, settings: [...raw.settings, raw.settings[0]] }).ok).toBe(false);
    expect(safeParseExtensionManifest({ ...raw, settings: [{ ...raw.settings[2], default: 'other' }] }).ok).toBe(false);
  });

  it('persists per-App settings across restart and upgrade, removes them on uninstall, and rejects corrupt storage', () => {
    const dir = work();
    const source = join(dir, 'source');
    mkdirSync(source);
    writeFileSync(join(source, 'manifest.json'), JSON.stringify({ ...raw, apiVersion: EXTENSION_API_VERSION, platforms: ['desktop'] }));
    writeFileSync(join(source, 'tools.js'), 'export const hello = {};');
    const root = join(dir, 'installed');
    const service = new ExtensionsService(root);
    const install = () => service.installFromDirectory(source, service.inspectDirectory(source).manifestDigest, 'folder');
    install();
    service.setSettings(raw.id, { account: 'work', enabled: false });
    expect(new ExtensionsService(root).settings(raw.id)).toEqual({ account: 'work', enabled: false, mode: 'local' });
    writeFileSync(join(source, 'manifest.json'), JSON.stringify({ ...raw, apiVersion: EXTENSION_API_VERSION, platforms: ['desktop'], version: '1.0.1' }));
    install();
    expect(service.settings(raw.id).account).toBe('work');
    service.uninstall(raw.id);
    install();
    expect(service.settings(raw.id).account).toBe('personal');
    writeFileSync(join(root, '.app-settings.json'), '[]');
    expect(() => service.settings(raw.id)).toThrow('Invalid App settings file');
  });
});
