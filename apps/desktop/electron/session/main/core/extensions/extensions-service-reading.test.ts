import fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import { ExtensionsService } from './extensions-service';

let root: string;
let bundle: string;
const manifest = (version: string) => ({
  id: 'demo', name: 'Demo', version, apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
  platforms: ['desktop'],
  entry: 'index.html',
  contributes: { tabs: [{ name: 'main', title: 'Demo' }] },
  permissions: { capabilities: ['agents:read'] },
});
const write = (value: object) => fs.writeFileSync(path.join(bundle, 'manifest.json'), JSON.stringify(value));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), 'bundle-reading-'));
  bundle = path.join(root, 'demo');
  fs.mkdirSync(bundle);
  fs.writeFileSync(path.join(bundle, 'index.html'), '<!doctype html>');
  write(manifest('1.0.0'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

it('asking again reads nothing while the files are the same', () => {
  const service = new ExtensionsService(root);
  const first = service.get('demo');
  expect(service.get('demo')).toBe(first);
});

it('an edit in place is seen on the next call', () => {
  const service = new ExtensionsService(root);
  expect(service.get('demo').manifest.version).toBe('1.0.0');
  write(manifest('1.0.1'));
  expect(service.get('demo').manifest.version).toBe('1.0.1');
});

it('a bundle landed by rename is seen on the next call, whatever its timestamps', () => {
  const service = new ExtensionsService(root);
  service.get('demo');
  const before = fs.statSync(path.join(bundle, 'manifest.json'));
  const staging = path.join(root, '.staging');
  fs.mkdirSync(staging);
  fs.writeFileSync(path.join(staging, 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest('2.0.0')));
  fs.utimesSync(path.join(staging, 'manifest.json'), before.atime, before.mtime);
  fs.rmSync(bundle, { recursive: true });
  fs.renameSync(staging, bundle);
  expect(service.get('demo').manifest.version).toBe('2.0.0');
});

it('a bundle that goes bad is refused on the next call, as before', () => {
  const service = new ExtensionsService(root);
  service.get('demo');
  fs.rmSync(path.join(bundle, 'index.html'));
  expect(() => service.get('demo')).toThrow(/entry|not found/i);
});

it('an entry swapped for a link out of the bundle is refused on the next call', () => {
  const service = new ExtensionsService(root);
  service.get('demo');
  const outside = path.join(root, '.outside.html');
  fs.writeFileSync(outside, 'x');
  fs.rmSync(path.join(bundle, 'index.html'));
  fs.symlinkSync(outside, path.join(bundle, 'index.html'));
  expect(() => service.get('demo')).toThrow(/escapes/);
});

it('a manifest that is a link inside the bundle is read anew every call', () => {
  const inner = path.join(bundle, 'real.json');
  fs.renameSync(path.join(bundle, 'manifest.json'), inner);
  fs.symlinkSync(inner, path.join(bundle, 'manifest.json'));
  const service = new ExtensionsService(root);
  expect(service.get('demo').manifest.version).toBe('1.0.0');
  fs.writeFileSync(inner, JSON.stringify(manifest('1.0.1')));
  expect(service.get('demo').manifest.version).toBe('1.0.1');
});

it('a capability taken back stops on the next call, with the reading kept', () => {
  const service = new ExtensionsService(root);
  expect(service.hasCapability('demo', 'agents:read')).toBe(true);
  service.setPermissionGranted('demo', 'agents:read', false);
  expect(service.hasCapability('demo', 'agents:read')).toBe(false);
});
