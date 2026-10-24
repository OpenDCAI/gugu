import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import { ExtensionsService } from './extensions-service';

/**
 * What an App's first install sets, and what it never sets again (App 插件体验, owner 10-06): its own choice of how its
 * tools reach agents (`contributes.toolsListed`) and a place on the rail. After that both are the person's.
 */

const work = mkdtempSync(path.join(tmpdir(), 'gugu-first-install-'));
let n = 0;

function bundle(contributes: Record<string, unknown>, version = '1.0.0', id = 'searcher'): string {
  const source = path.join(work, `source-${++n}`);
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, 'index.html'), '<p>settings</p>');
  writeFileSync(path.join(source, 'tools.js'), 'export const search = { description: "Search", inputSchema: { type: "object" }, run: () => "" };');
  writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({
    id, name: 'Searcher', version, apiVersion: EXTENSION_API_VERSION, platforms: ['desktop'], entry: 'index.html',
    permissions: { capabilities: contributes.mcpServers ? ['agents:tools'] : [] },
    contributes,
  }));
  return source;
}

const page = { name: 'settings', title: 'Searcher' };
const program = [{ tools: 'tools.js' }];

function install(service: ExtensionsService, source: string, origin: 'folder' | 'preinstalled' = 'folder'): void {
  service.installFromDirectory(source, service.inspectDirectory(source).manifestDigest, origin);
}

describe("an App's first install (App 插件体验)", () => {
  it('toolsListed lists its tools from the first install; the person can switch it back, and no upgrade turns it', () => {
    const service = new ExtensionsService(path.join(work, 'installed-listed'));
    install(service, bundle({ tabs: [page], mcpServers: program, toolsListed: true }));
    expect(service.disclosure('searcher')).toBe('full');
    service.setDisclosure('searcher', 'progressive');
    install(service, bundle({ tabs: [page], mcpServers: program, toolsListed: true }, '1.0.1'));
    expect(service.disclosure('searcher')).toBe('progressive');
    // Uninstalling forgets the person's choice too: the next install is a first one again.
    service.uninstall('searcher');
    install(service, bundle({ tabs: [page], mcpServers: program, toolsListed: true }, '1.0.2'));
    expect(service.disclosure('searcher')).toBe('full');
  });

  it('without it the tools stay in the catalog (D-10), and an upgrade that adds it changes nothing', () => {
    const service = new ExtensionsService(path.join(work, 'installed-catalog'));
    install(service, bundle({ tabs: [page], mcpServers: program }));
    expect(service.disclosure('searcher')).toBe('progressive');
    install(service, bundle({ tabs: [page], mcpServers: program, toolsListed: true }, '1.0.1'));
    expect(service.disclosure('searcher')).toBe('progressive');
  });

  it('toolsListed without a program is refused, saying why', () => {
    const service = new ExtensionsService(path.join(work, 'installed-refused'));
    expect(() => service.inspectDirectory(bundle({ tabs: [page], toolsListed: true })))
      .toThrow(/toolsListed lists the tools of the App's programs, and there are no contributes\.mcpServers/);
  });

  it('an App with a page of its own goes on the rail once; taken off, an upgrade leaves it off', () => {
    const service = new ExtensionsService(path.join(work, 'installed-dock'));
    install(service, bundle({ tabs: [page] }, '1.0.0', 'notes'));
    install(service, bundle({ tabs: [page] }, '1.0.0', 'board'));
    expect(service.dock()).toEqual(['notes', 'board']);
    service.setDock(['board']);
    install(service, bundle({ tabs: [page] }, '1.0.1', 'notes'));
    expect(service.dock()).toEqual(['board']);
  });

  it('an App that only opens files is not put on the rail', () => {
    const service = new ExtensionsService(path.join(work, 'installed-no-dock'));
    install(service, bundle({ tabs: [{ name: 'viewer', title: 'Viewer', opensFiles: { chat: ['.demo'] } }] }, '1.0.0', 'viewer'));
    install(service, bundle({ tabs: [{ name: 'main', title: 'Files', opensFiles: { chat: ['.md'] } }] }, '1.0.0', 'files'), 'preinstalled');
    expect(service.dock()).toEqual([]);
  });

  it('one rule whoever installed it: a preinstalled App with a page of its own goes on the rail once too', () => {
    const service = new ExtensionsService(path.join(work, 'installed-preinstalled-dock'));
    install(service, bundle({ tabs: [page] }, '1.0.0', 'shipped'), 'preinstalled');
    expect(service.dock()).toEqual(['shipped']);
    // gugu installs its Apps again at every start: taken off, a start leaves it off.
    service.setDock([]);
    install(service, bundle({ tabs: [page] }, '1.0.0', 'shipped'), 'preinstalled');
    expect(service.dock()).toEqual([]);
  });
});
