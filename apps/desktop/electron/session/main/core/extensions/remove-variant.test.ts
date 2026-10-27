import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import { ExtensionsService } from './extensions-service';
import type { ExtensionVariant } from '@shared/extensions/variants';

let service: ExtensionsService;
vi.mock('./extensions-root', () => ({ extensionsService: () => service }));
vi.mock('./app-given', () => ({ installAsk: async () => null, recordGiven: async () => undefined }));
vi.mock('./extension-after-install', () => ({ applyInstalledExtension: vi.fn() }));
vi.mock('./market-ranking', () => ({ recordMarketInstall: vi.fn() }));
vi.mock('./extension-bridge-relay', () => ({ requestExtensionInstallConsent: vi.fn(), announceInstalledChanged: vi.fn(async () => 'shown') }));
const { removeExtensionVariant } = await import('./extension-variants');
let root: string;
let source: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'gugu-remove-fork-'));
  source = path.join(root, 'source');
  mkdirSync(source);
  const manifest = { id: 'demo', name: 'Demo', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, platforms: ['desktop'], entry: 'index.html', contributes: { tabs: [{ name: 'main', title: 'Demo' }] } };
  writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(path.join(source, 'index.html'), 'original');
  service = new ExtensionsService(path.join(root, 'extensions'));
  const digest = service.inspectDirectory(source).manifestDigest;
  service.installFromDirectory(source, digest, 'market');
  const upstream: ExtensionVariant = { name: 'upstream', base: '1.0.0', commit: 'a'.repeat(40), repo: 'owner/repo', path: '.', dir: null, sha256: '1'.repeat(64), bytes: 8 };
  service.retainUpstream('demo', upstream);
  writeFileSync(path.join(source, 'index.html'), 'custom');
  service.installFromDirectory(source, digest, 'fork', { id: 'gugu' }, { ...upstream, name: 'mine', dir: source });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it.each(['declined', 'dismissed', 'timeout'] as const)('keeps the active fork and source on %s', async (outcome) => {
  const requestInstallConsent = vi.fn(async () => ({ outcome }));
  expect(await removeExtensionVariant('demo', 'mine', undefined, { requestInstallConsent })).toEqual({ removed: false, outcome });
  expect(requestInstallConsent).toHaveBeenCalledWith(expect.objectContaining({ removeVariant: { name: 'mine', active: true } }));
  expect(service.variants('demo').active).toBe('mine');
  expect(readFileSync(path.join(service.get('demo').rootDir, 'index.html'), 'utf8')).toBe('custom');
  expect(existsSync(service.variantDirectory('demo', 'mine'))).toBe(true);
});
it('returns the human question without switching; a different digest is rejected', async () => {
  const returned = await removeExtensionVariant('demo', 'mine', { kind: 'return' });
  expect(returned).toMatchObject({ outcome: 'ask', asks: true, ask: { removeVariant: { name: 'mine', active: true } } });
  expect(service.variants('demo').active).toBe('mine');
  await expect(removeExtensionVariant('demo', 'mine', { kind: 'given', digest: 'other' })).rejects.toThrow('changed');
});
it('confirmed active deletion uses the install transaction, retains original/data/source/places, then removes the fork', async () => {
  const identity = service.identityOf('demo')!;
  service.setGivenHere(identity, ['here:all']);
  writeFileSync(path.join(root, 'data'), 'saved');
  const afterInstall = vi.fn();
  const result = await removeExtensionVariant('demo', 'mine', undefined, { requestInstallConsent: async () => ({ outcome: 'confirmed' }), afterInstall });
  expect(result).toMatchObject({ removed: true, active: 'upstream' });
  expect(afterInstall).toHaveBeenCalledOnce();
  expect(readFileSync(path.join(service.get('demo').rootDir, 'index.html'), 'utf8')).toBe('original');
  expect(service.variants('demo').variants.map((row) => row.name)).toEqual(['upstream']);
  expect(service.identityOf('demo')).toEqual(identity);
  expect(service.givenHere(identity)).toEqual(['here:all']);
  expect(readFileSync(path.join(root, 'data'), 'utf8')).toBe('saved');
  expect(readFileSync(path.join(source, 'index.html'), 'utf8')).toBe('custom');
});
it('requires confirmation even for an inactive fork, without reinstalling the current App', async () => {
  const upstream = service.variants('demo').variants[0]!;
  const dir = service.variantDirectory('demo', 'upstream');
  service.installFromDirectory(dir, service.inspectDirectory(dir).manifestDigest, 'market', undefined, upstream);
  const afterInstall = vi.fn();
  const requestInstallConsent = vi.fn(async () => ({ outcome: 'confirmed' as const }));
  expect(await removeExtensionVariant('demo', 'mine', undefined, { requestInstallConsent, afterInstall })).toMatchObject({ removed: true, active: 'upstream' });
  expect(requestInstallConsent).toHaveBeenCalledOnce();
  expect(afterInstall).not.toHaveBeenCalled();
});
it('refuses stale human consent after a variant changes, before switching or removing', async () => {
  await expect(removeExtensionVariant('demo', 'mine', undefined, { requestInstallConsent: async () => {
    const other = service.variants('demo').variants.find((row) => row.name === 'mine')!;
    service.installFromDirectory(source, service.inspectDirectory(source).manifestDigest, 'fork', { id: 'gugu' }, { ...other, commit: 'b'.repeat(40) });
    return { outcome: 'confirmed' };
  } })).rejects.toThrow('changed while');
  expect(service.variants('demo').active).toBe('mine');
});
it('retains the fork when switching fails', async () => {
  vi.spyOn(service, 'installFromDirectory').mockImplementationOnce(() => { throw new Error('disk full'); });
  await expect(removeExtensionVariant('demo', 'mine', undefined, { requestInstallConsent: async () => ({ outcome: 'confirmed' }) })).rejects.toThrow('disk full');
  expect(service.variants('demo').active).toBe('mine');
  expect(existsSync(service.variantDirectory('demo', 'mine'))).toBe(true);
});
