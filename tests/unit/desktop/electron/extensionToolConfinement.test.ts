import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extensionAgentPrograms } from '../../../../apps/desktop/electron/extension-session-mcp';
import { ExtensionsService } from '../../../../apps/desktop/electron/session/main/core/extensions/extensions-service';
import { EXTENSION_API_VERSION, parseExtensionManifest, type ExtensionMcpServerContribution } from '@shared/extensions/manifest';
import { describeCapability, type SessionTranslate } from '@renderer/features/extensions/extension-consent';
import { enUSMessages, zhCNMessages } from '@renderer/localization/messages';

const dirs: string[] = [];
const folder = () => { const dir = mkdtempSync(join(tmpdir(), 'gugu-confined-tools-')); dirs.push(dir); return dir; };
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    expect(dir.startsWith(join(tmpdir(), 'gugu-confined-tools-'))).toBe(true);
    process.stderr.write(`Remove own fixture: ${dir}\n`);
    rmSync(dir, { recursive: true, force: true });
  }
});
const say = (messages: Record<string, string>) => ((key: string, params: Record<string, string> = {}) =>
  messages[key]!.replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? `{${name}}`)) as SessionTranslate;
function manifest(apiVersion = EXTENSION_API_VERSION, servers: ExtensionMcpServerContribution[] = [{ tools: 'tools.js' }]) {
  return parseExtensionManifest({ id: 'confined-tools', name: 'Tools', version: '1.0.0', apiVersion, defaultLocale: 'en',
    entry: 'index.html', permissions: { capabilities: ['agents:tools'], network: ['example.com'] },
    contributes: { tabs: [{ name: 'main', title: 'Tools' }], instructions: 'Fixture tools.', mcpServers: servers } });
}

describe('tools confinement follows the installed API and program form', () => {
  it('hands new tools the bundle/runtime/data roots and the granted host list', () => {
    const rootDir = folder();
    writeFileSync(join(rootDir, 'tools.js'), 'export const fixture = {}');
    const toolsRuntime = join(rootDir, 'runtime', 'gugu-tools.mjs');
    const dataDir = join(rootDir, 'data');
    const { programs } = extensionAgentPrograms([{ extensionId: 'confined-tools', name: 'Tools', rootDir, dataDir,
      apiVersion: EXTENSION_API_VERSION, networkHosts: ['example.com'], digest: 'fixture', disclosure: 'progressive',
      servers: [{ tools: 'tools.js' }], skillsDir: null }], { nodeExecutable: process.execPath, toolsRuntime,
      linkPrefix: 'gugu://ext', onProblem: vi.fn() });
    expect(programs[0]).toMatchObject({ confine: { fsRead: [rootDir, dirname(toolsRuntime), dataDir], fsWrite: [dataDir], hosts: ['example.com'] } });
  });

  it.each([
    [27, { tools: 'tools.js' }],
    [EXTENSION_API_VERSION, { name: 'node', command: 'node' }],
    [EXTENSION_API_VERSION, { name: 'external', command: './program' }],
  ] as const)('preserves legacy or command execution (%s, %j)', (apiVersion, server) => {
    const rootDir = folder(); writeFileSync(join(rootDir, 'tools.js'), '');
    const { programs } = extensionAgentPrograms([{ extensionId: 'confined-tools', name: 'Tools', rootDir, dataDir: join(rootDir, 'data'),
      apiVersion, digest: 'fixture', disclosure: 'progressive', servers: [server], skillsDir: null }],
    { nodeExecutable: process.execPath, toolsRuntime: join(rootDir, 'runtime', 'gugu-tools.mjs'), linkPrefix: 'gugu://ext', onProblem: vi.fn() });
    expect(programs[0]?.confine ?? null).toBeNull();
  });

  it('narrows local and remote consent only when every program is confined, in both languages', () => {
    for (const messages of [enUSMessages, zhCNMessages]) {
      for (const machine of [undefined, 'Fixture computer']) {
        const text = describeCapability('agents:tools', manifest(), say(messages), machine);
        expect(text).toContain('example.com');
        expect(text).toContain(machine ?? (messages === enUSMessages ? 'your computer' : '你的电脑'));
        expect(text).not.toMatch(/\{\w+\}/);
        const broad = describeCapability('agents:tools', manifest(27), say(messages), machine);
        expect(broad).toContain(messages === enUSMessages ? 'can reach the internet' : '程序能联网');
        const mixed = describeCapability('agents:tools', manifest(EXTENSION_API_VERSION,
          [{ tools: 'tools.js' }, { name: 'node', command: 'node' }]), say(messages), machine);
        expect(mixed).toBe(broad);
      }
    }
  });

  it('omits the host exception when a confined tools App declares no network', () => {
    const app = manifest(); app.permissions!.network = [];
    const text = describeCapability('agents:tools', app, say(enUSMessages));
    expect(text).toContain('keeps it from reaching the internet and from your files');
    expect(text).not.toContain('except example.com');
  });

  it.each(['hidden-link', 'store/hidden-link', 'node_modules/hidden-link'])('refuses %s on folder inspection AND installation, without changing legacy installs', (link) => {
    const root = folder(); const bundle = join(root, 'bundle'); mkdirSync(bundle);
    writeFileSync(join(bundle, 'index.html'), '<!doctype html>');
    writeFileSync(join(bundle, 'tools.js'), 'export const fixture = {}');
    writeFileSync(join(root, 'outside.txt'), 'noncredential fixture');
    const writeManifest = (apiVersion: number, servers?: ExtensionMcpServerContribution[]) =>
      writeFileSync(join(bundle, 'manifest.json'), JSON.stringify(manifest(apiVersion, servers)));
    const service = new ExtensionsService(join(root, 'installed'));
    writeManifest(EXTENSION_API_VERSION);
    const digest = service.inspectDirectory(bundle).manifestDigest;
    mkdirSync(dirname(join(bundle, link)), { recursive: true });
    symlinkSync(join(root, 'outside.txt'), join(bundle, link));
    expect(() => service.inspectDirectory(bundle)).toThrow(`symbolic link: ${link}`);
    expect(() => service.installFromDirectory(bundle, digest, 'folder')).toThrow(`symbolic link: ${link}`);
    writeManifest(27);
    expect(() => service.inspectDirectory(bundle)).not.toThrow();
    writeManifest(EXTENSION_API_VERSION, [{ name: 'node', command: 'node' }]);
    expect(() => service.inspectDirectory(bundle)).not.toThrow();
  });
});
