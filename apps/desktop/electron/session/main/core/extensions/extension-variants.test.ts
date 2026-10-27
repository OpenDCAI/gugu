import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_API_VERSION, type ExtensionManifest } from '@shared/extensions/manifest';
import { type ExtensionVariant, forkBehind } from '@shared/extensions/variants';
import type { MarketIndexVersion } from '@shared/extensions/market';
import { ExtensionsService } from './extensions-service';
import { installPlan } from './install-plan';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'gugu-fork-variants-'));
  roots.push(root);
  const source = path.join(root, 'source');
  mkdirSync(source);
  const manifest: ExtensionManifest = { id: 'demo', name: 'Demo', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, platforms: ['desktop'], entry: 'index.html', contributes: { tabs: [{ name: 'main', title: 'Demo' }] }, permissions: { capabilities: ['files:read'], network: ['example.com'] } };
  writeFileSync(path.join(source, 'index.html'), 'upstream');
  const save = () => writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(manifest));
  save();
  const service = new ExtensionsService(path.join(root, 'task-extensions'));
  service.installFromDirectory(source, service.inspectDirectory(source).manifestDigest, 'market');
  const upstream: ExtensionVariant = { name: 'upstream', base: '1.0.0', commit: 'a'.repeat(40), repo: 'owner/repo', path: '.', dir: null, sha256: '1'.repeat(64), bytes: 42 };
  service.retainUpstream('demo', upstream);
  const install = (dir: string, variant: ExtensionVariant) => service.installFromDirectory(dir, service.inspectDirectory(dir).manifestDigest, variant.name === 'upstream' ? 'market' : 'fork', variant.name === 'upstream' ? undefined : { id: 'gugu' }, variant);
  const fork = { ...upstream, name: 'mine', dir: source };
  return { root, source, manifest, service, save, upstream, fork, install };
}

describe('App variants use the installed App identity and the existing install transaction', () => {
  it('switches code, keeps identity, places, settings and data, then restores the original upstream code', () => {
    const { root, source, service, fork, upstream, install } = setup();
    service.setGivenHere({ id: 'demo', publisher: 'gugu' }, ['here:all']);
    const data = path.join(root, 'data');
    writeFileSync(data, 'my saved state');
    writeFileSync(path.join(source, 'index.html'), 'fork');
    expect(installPlan(service, service.inspectDirectory(source).manifest, 'fork').asks).toBe(false);
    install(source, fork);
    expect(service.origins().demo).toBe('fork');
    expect(service.identityOf('demo')).toEqual({ id: 'demo', publisher: 'gugu' });
    expect(service.givenHere(service.identityOf('demo')!)).toEqual(['here:all']);
    expect(readFileSync(path.join(service.get('demo').rootDir, 'index.html'), 'utf8')).toBe('fork');
    install(service.variantDirectory('demo', 'upstream'), upstream);
    expect(readFileSync(path.join(service.get('demo').rootDir, 'index.html'), 'utf8')).toBe('upstream');
    expect(readFileSync(data, 'utf8')).toBe('my saved state');
    expect(service.variants('demo').active).toBe('upstream');
    expect(readFileSync(path.join(service.variantDirectory('demo', 'mine'), 'index.html'), 'utf8')).toBe('fork');
  });

  it('asks for only new grants, remembers their union, and keeps withdrawals across less capable variants', () => {
    const { source, manifest, save, service, fork, upstream, install } = setup();
    service.setPermissionGranted('demo', 'files:read', false);
    manifest.permissions!.capabilities!.push('chat:relay');
    save();
    const plan = installPlan(service, service.inspectDirectory(source).manifest, 'fork');
    expect(plan.newlyAsked).toEqual(['chat:relay']);
    expect(plan.asks).toBe(true);
    install(source, fork);
    service.setPermissionGranted('demo', 'chat:relay', false);
    install(service.variantDirectory('demo', 'upstream'), upstream);
    expect(service.revokedPermissions('demo')).toEqual(['files:read', 'chat:relay']);
    expect(installPlan(service, service.inspectDirectory(source).manifest, 'fork').asks).toBe(false);
    expect(service.grantedCapabilities('demo')).not.toContain('files:read');
    expect(service.grantedCapabilities('demo')).not.toContain('chat:relay');
  });

  it('repairs an unreadable installed manifest while retaining its recorded approvals', () => {
    const { source, manifest, save, service, fork, upstream, install } = setup();
    manifest.permissions!.capabilities!.push('chat:relay');
    save();
    install(source, fork);
    writeFileSync(path.join(service.get('demo').rootDir, 'manifest.json'), '{broken');
    expect(() => install(service.variantDirectory('demo', 'upstream'), upstream)).not.toThrow();
    expect(service.approvedManifest('demo').permissions?.capabilities).toContain('chat:relay');
  });

  it('refuses a changed manifest before altering the active variant and removes variant copies on uninstall', () => {
    const { source, manifest, save, service, fork } = setup();
    const digest = service.inspectDirectory(source).manifestDigest;
    manifest.permissions!.capabilities!.push('chat:relay');
    save();
    expect(() => service.installFromDirectory(source, digest, 'fork', { id: 'gugu' }, fork)).toThrow('changed');
    expect(service.variants('demo').active).toBe('upstream');
    service.uninstall('demo');
    expect(existsSync(path.dirname(service.variantDirectory('demo', 'upstream')))).toBe(false);
  });
});

it('counts only live releases newer than the fork base and returns their newest exact source commit', () => {
  const versions = ['1.0.0', '1.1.0', '1.2.0', '1.3.0'].map((version, i) => ({ version, source: { commit: String(i).repeat(40) }, yanked: i === 2 ? { reason: 'withdrawn' } : null }) as MarketIndexVersion);
  expect(forkBehind('1.0.0', versions)).toEqual({ upstream: '1.3.0', behind: 2, commit: '3'.repeat(40) });
  expect(forkBehind('1.3.0', versions)).toBeNull();
});


it('removes only an inactive fork cache and registration, preserving original, source, settings, data and grants', () => {
  const { root, source, service, fork, upstream, install } = setup();
  service.setGivenHere(service.identityOf('demo')!, ['here:all']);
  service.setPermissionGranted('demo', 'files:read', false);
  const data = path.join(root, 'data');
  writeFileSync(data, 'saved');
  install(source, fork);
  expect(() => service.removeVariant('demo', 'mine')).toThrow('Switch');
  expect(() => service.removeVariant('demo', 'upstream')).toThrow('original');
  expect(() => service.removeVariant('demo', 'unknown')).toThrow('installed fork');
  install(service.variantDirectory('demo', 'upstream'), upstream);
  expect(service.removeVariant('demo', 'mine')).toEqual({ removed: true });
  expect(service.variants('demo')).toEqual({ active: 'upstream', variants: [upstream] });
  expect(existsSync(service.variantDirectory('demo', 'mine'))).toBe(false);
  expect(existsSync(service.variantDirectory('demo', 'upstream'))).toBe(true);
  expect(existsSync(source)).toBe(true);
  expect(readFileSync(data, 'utf8')).toBe('saved');
  expect(service.identityOf('demo')).toEqual({ id: 'demo', publisher: 'gugu' });
  expect(service.givenHere(service.identityOf('demo')!)).toEqual(['here:all']);
  expect(service.revokedPermissions('demo')).toContain('files:read');
});

it('reports registration removal separately when the inactive fork cache cannot be cleared', () => {
  const { source, service, fork, upstream, install } = setup();
  install(source, fork);
  install(service.variantDirectory('demo', 'upstream'), upstream);
  const cache = service.variantDirectory('demo', 'mine');
  vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => { throw new Error('cache locked'); });
  expect(service.removeVariant('demo', 'mine')).toMatchObject({ removed: true, warning: expect.stringContaining('cache locked') });
  expect(service.variants('demo').variants.map((row) => row.name)).toEqual(['upstream']);
  expect(existsSync(cache)).toBe(true);
  expect(service.get('demo').manifest.id).toBe('demo');
});
