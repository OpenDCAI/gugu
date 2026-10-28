import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { DWS_LINUX_PRODUCT, installManagedProduct, managedProductRoot } from './cli-managed-products';

let root: string;
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); if (root) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  root = await fs.mkdtemp(path.join(tmpdir(), 'gugu-cli-products-'));
  const source = path.join(root, 'product'); await fs.mkdir(path.join(source, 'bin'), { recursive: true });
  await fs.mkdir(path.join(source, 'skills/dws'), { recursive: true });
  await fs.writeFile(path.join(source, 'bin/dws'), 'real product bytes');
  await fs.writeFile(path.join(source, 'skills/dws/SKILL.md'), 'instructions');
  const archive = path.join(root, 'source.tgz'); execFileSync('tar', ['-czf', archive, '-C', source, 'bin', 'skills']);
  const data = await fs.readFile(archive); const sha256 = createHash('sha256').update(data).digest('hex');
  await fs.rename(archive, path.join(root, `${sha256}.tgz`));
  return { sha256, archiveBytes: data.length, bin: 'dws', requiredSkill: 'dws/SKILL.md' };
}
it('copies a content-addressed product from the read-only mount and unpacks locally without any HTTP request', async () => {
  const product = await fixture(); const stage = path.join(root, 'stage'); const progress: unknown[] = [];
  const fetch = vi.fn(() => { throw new Error('No network download'); }); vi.stubGlobal('fetch', fetch);
  await installManagedProduct(root, product, stage, p => progress.push(p));
  expect(await fs.readFile(path.join(stage, 'bin/dws'), 'utf8')).toBe('real product bytes');
  expect(await fs.readFile(path.join(stage, 'skills/dws/SKILL.md'), 'utf8')).toBe('instructions');
  expect(progress).toContainEqual(expect.objectContaining({ receivedBytes: product.archiveBytes, totalBytes: product.archiveBytes }));
  expect(fetch).not.toHaveBeenCalled();
});
it('rejects changed bytes before extraction', async () => {
  const product = await fixture(); await fs.writeFile(path.join(root, product.sha256+'.tgz'), 'tampered');
  const stage = path.join(root, 'stage');
  await expect(installManagedProduct(root, product, stage, () => {})).rejects.toThrow('integrity mismatch');
  await expect(fs.stat(path.join(stage, 'bin/dws'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('rejects a selected product disappearing before its copy without switching origins', async () => {
  const product = await fixture(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(installManagedProduct(path.join(root, 'unmounted'), product, path.join(root, 'stage'), () => {})).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps the original installer available for an unmounted account or another platform', async () => {
  await fixture(); vi.stubEnv('GUGU_CLOUD_COMPUTER','1'); vi.stubEnv('GUGU_CLI_PRODUCT_ROOT',path.join(root,'not-mounted'));
  expect(managedProductRoot('dws','linux-x64')).toBeUndefined();
  expect(managedProductRoot('dws','linux-arm64')).toBeUndefined();
  vi.stubEnv('GUGU_CLI_PRODUCT_ROOT',root);
  // Only the release product itself opts into the managed path.
  expect(managedProductRoot('dws','linux-x64')).toBeUndefined();
  await fs.writeFile(path.join(root,DWS_LINUX_PRODUCT.sha256+'.tgz'),'release product present');
  expect(managedProductRoot('dws','linux-x64')).toBe(root);
  expect(managedProductRoot('dws','linux-arm64')).toBeUndefined();
});
