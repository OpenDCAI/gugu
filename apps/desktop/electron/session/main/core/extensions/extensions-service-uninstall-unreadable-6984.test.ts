import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import { ExtensionsService } from './extensions-service';

/** #6984 An App switched off before its manifest stopped reading (an older apiVersion) must still uninstall. */

function setup() {
  const work = mkdtempSync(path.join(tmpdir(), 'gugu-6984-uninstall-'));
  const source = path.join(work, 'source');
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, 'index.html'), '<p>demo</p>');
  writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({
    id: 'demo-ext', name: 'Demo', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, entry: 'index.html',
    contributes: { tabs: [{ name: 'main', title: 'Demo' }] },
  }));
  const root = path.join(work, 'installed');
  const service = new ExtensionsService(root);
  const install = () => service.installFromDirectory(source, service.inspectDirectory(source).manifestDigest, 'folder');
  install();
  return { service, root, install };
}

describe('uninstalling an App whose manifest no longer reads (#6984)', () => {
  it('removes it even though it was switched off and listed natively, and a reinstall arrives on and progressive', () => {
    const { service, root, install } = setup();
    service.setEnabled('demo-ext', false);
    service.setDisclosure('demo-ext', 'full');
    // What a build that dropped apiVersion 1 sees for an App installed before it.
    writeFileSync(path.join(root, 'demo-ext', 'manifest.json'), JSON.stringify({
      id: 'demo-ext', name: 'Demo', version: '1.0.0', apiVersion: 1, entry: 'index.html',
      contributes: { tabs: [{ name: 'main', title: 'Demo' }] },
    }));
    expect(service.list().invalid.map((entry) => entry.dirName)).toEqual(['demo-ext']);

    service.uninstall('demo-ext');

    expect(service.isInstalled('demo-ext')).toBe(false);
    expect(service.list().invalid).toEqual([]);
    install();
    expect(service.isEnabled('demo-ext')).toBe(true);
    expect(service.disclosure('demo-ext')).toBe('progressive');
  });
});
