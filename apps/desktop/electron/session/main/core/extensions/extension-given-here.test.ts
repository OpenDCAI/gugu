import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import { HERE_ALL } from '@shared/extensions/host-actions';
import { ExtensionsService } from './extensions-service';

/**
 * D-30 「给哪些 agent」, this computer's half: kept by the App's identity next to its install. Never chosen reads as null (the
 * App reaches every agent here); a choice — even none — is kept as it is; uninstalling forgets it.
 */
const work = mkdtempSync(path.join(tmpdir(), 'gugu-given-here-'));

function installed(): ExtensionsService {
  const source = path.join(work, `source-${Math.random().toString(36).slice(2)}`);
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, 'index.html'), '<p>search</p>');
  writeFileSync(path.join(source, 'tools.js'), 'export const search = { description: "Search", inputSchema: { type: "object" }, run: () => "" };');
  writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({
    id: 'searcher', name: 'Searcher', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, entry: 'index.html',
    permissions: { capabilities: ['agents:tools'] },
    contributes: { tabs: [{ name: 'main', title: 'Searcher' }], mcpServers: [{ tools: 'tools.js' }] },
  }));
  const service = new ExtensionsService(path.join(work, `installed-${Math.random().toString(36).slice(2)}`));
  service.installFromDirectory(source, service.inspectDirectory(source).manifestDigest, 'folder', { id: 'owner-1' });
  return service;
}

describe("which agents here get an App's tools (D-30)", () => {
  it('is null until the person chooses, then exactly what they chose — none included', () => {
    const service = installed();
    const app = service.identityOf('searcher')!;
    expect(app).toEqual({ publisher: 'owner-1', id: 'searcher' });
    expect(service.givenHere(app)).toBeNull();
    service.setGivenHere(app, [HERE_ALL, HERE_ALL]);
    expect(service.givenHere(app)).toEqual([HERE_ALL]);
    service.setGivenHere(app, []);
    expect(service.givenHere(app)).toEqual([]);
  });

  it('belongs to that publisher’s App: another publisher’s App under the same id has no choice yet', () => {
    const service = installed();
    service.setGivenHere({ publisher: 'owner-1', id: 'searcher' }, [HERE_ALL]);
    expect(service.givenHere({ publisher: 'someone-else', id: 'searcher' })).toBeNull();
  });

  it('is forgotten when the App is uninstalled', () => {
    const service = installed();
    const app = service.identityOf('searcher')!;
    service.setGivenHere(app, []);
    service.uninstall('searcher');
    expect(service.givenHere(app)).toBeNull();
  });
});
