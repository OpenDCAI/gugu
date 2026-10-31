import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import { ExtensionsService } from './extensions-service';

/** #6615 D-10: an extension's tools reach new sessions natively only when the person chose `full`. */

function installed(): ExtensionsService {
  const work = mkdtempSync(path.join(tmpdir(), 'gugu-6615-disclosure-'));
  const source = path.join(work, 'source');
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, 'index.html'), '<p>demo</p>');
  writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({
    id: 'demo-ext', name: 'Demo', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', platforms: ['desktop'], entry: 'index.html',
    contributes: { tabs: [{ name: 'main', title: 'Demo' }] },
  }));
  const service = new ExtensionsService(path.join(work, 'installed'));
  service.installFromDirectory(source, service.inspectDirectory(source).manifestDigest, 'folder');
  return service;
}

describe('extension disclosure (#6615)', () => {
  it('is progressive until the person lists it natively, and back', () => {
    const service = installed();
    expect(service.disclosure('demo-ext')).toBe('progressive');
    service.setDisclosure('demo-ext', 'full');
    expect(service.disclosure('demo-ext')).toBe('full');
    service.setDisclosure('demo-ext', 'progressive');
    expect(service.disclosure('demo-ext')).toBe('progressive');
  });

  it('is a decision about an installed extension: refused otherwise, and forgotten on uninstall', () => {
    const service = installed();
    expect(() => service.setDisclosure('not-here', 'full')).toThrow(/not installed/);
    service.setDisclosure('demo-ext', 'full');
    service.uninstall('demo-ext');
    expect(service.disclosure('demo-ext')).toBe('progressive');
  });
});
