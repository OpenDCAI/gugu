import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import { ExtensionsService } from './extensions-service';
import { packExtensionArchive } from './extension-archive';

/**
 * #7290 app_install { device, source_dir }: the owner's folder, packed on their other machine, is installed here as a
 * folder is — origin 'folder', the person signed in here its publisher (no card, no publisher to read off anything). Its
 * bytes come over the device channel, part by part (`receive_package_part`, named by the machine that sent them); the
 * digest that machine packed decides — other bytes are refused. What arrived stays for the install the person agreed to
 * after an ask, and goes once the install is answered.
 */
const state = vi.hoisted(() => ({ service: null as unknown, userData: '' }));
const ME = '0a000000-0000-4000-8000-00000000000a';
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }));
vi.mock('./extensions-root', () => ({ extensionsService: () => state.service }));
vi.mock('./app-files', () => ({ folderPublisher: async () => ({ id: ME }) }));

const { runExtensionAgentAction } = await import('./extension-agent-actions');

const THERE = 'device-b';
const quiet = { afterInstall: () => {}, notifyInstalledChanged: async () => {} };
let work: string;
let service: ExtensionsService;

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'gugu-7290-folder-package-'));
  state.userData = path.join(work, 'userData');
  service = new ExtensionsService(path.join(state.userData, 'task-extensions'));
  state.service = service;
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** The owner's folder, packed on the other machine and sent here part by part (a part is at most 512 KiB): its upload and digest. */
async function sentFromThere(network?: string[], from = THERE): Promise<{ upload: string; digest: string }> {
  const dir = path.join(work, 'src', 'share');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id: 'share', name: 'Share', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, platforms: ['desktop'], entry: 'index.html',
    ...(network ? { permissions: { network } } : {}), contributes: { tabs: [{ name: 'main', title: 'Share' }] },
  }));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html>');
  const { bytes, sha256 } = await packExtensionArchive(service, dir);
  const upload = randomUUID();
  const half = Math.ceil(bytes.length / 2);
  for (const [offset, part] of [[0, bytes.subarray(0, half)], [half, bytes.subarray(half)]] as const) {
    await runExtensionAgentAction({
      action: 'receive_package_part', from_device: from, upload_id: upload, offset, total: bytes.length,
      final: offset + part.length >= bytes.length, data: Buffer.from(part).toString('base64'),
    }, quiet);
  }
  return { upload, digest: sha256 };
}
const install = (upload: string, digest: string) =>
  runExtensionAgentAction({ action: 'install_folder_package', from_device: THERE, upload_id: upload, digest }, quiet);

describe('#7290 install_folder_package: the owner\'s folder from their other machine, over the device channel', () => {
  it('installed as a folder (origin folder, the person here its publisher), from the bytes that arrived; then they are gone', async () => {
    const { upload, digest } = await sentFromThere();
    await expect(install(upload, digest)).resolves.toMatchObject({ installed: true, id: 'share' });
    expect(service.origins()).toEqual({ share: 'folder' });
    expect(service.publishers()).toEqual({ share: { id: ME } });
    await expect(install(upload, digest)).rejects.toThrow(/not here/);
  });

  it('bytes that are not the ones packed there: refused, nothing installed (and they are gone)', async () => {
    const { upload, digest } = await sentFromThere();
    const other = createHash('sha256').update('another package').digest('hex');
    await expect(install(upload, other)).rejects.toThrow(`(sha256 ${digest}, expected ${other}): not installed`);
    expect(service.list().extensions).toEqual([]);
    await expect(install(upload, digest)).rejects.toThrow(/not here/);
  });

  it('only the machine that sent them names them: the same upload id from another machine is not here', async () => {
    const { upload, digest } = await sentFromThere(undefined, 'device-c');
    await expect(install(upload, digest)).rejects.toThrow(/not here/);
    expect(service.list().extensions).toEqual([]);
  });

  it('a part out of order is refused (send it again from the start)', async () => {
    await expect(runExtensionAgentAction({
      action: 'receive_package_part', from_device: THERE, upload_id: randomUUID(), offset: 9, total: 20, final: false, data: 'AAAA',
    }, quiet)).rejects.toThrow(/lost its earlier parts|earlier/);
  });

  it('D-31: `return` hands back what would be asked (the bytes stay); `given` installs those bytes only, asking nobody here', async () => {
    const { upload, digest } = await sentFromThere(['api.example.com']);
    const requestInstallConsent = vi.fn();
    const deps = { ...quiet, requestInstallConsent };
    const first = await runExtensionAgentAction({ action: 'install_folder_package', from_device: THERE, upload_id: upload, digest, consent: { kind: 'return' } }, deps) as { outcome: string; ask: { manifestDigest: string } };
    expect(first).toMatchObject({ installed: false, outcome: 'ask', id: 'share' });
    expect(service.list().extensions).toEqual([]);
    await expect(runExtensionAgentAction({ action: 'install_folder_package', from_device: THERE, upload_id: upload, digest, consent: { kind: 'given', digest: first.ask.manifestDigest } }, deps))
      .resolves.toMatchObject({ installed: true, id: 'share' });
    expect(requestInstallConsent).not.toHaveBeenCalled();
    expect(service.origins()).toEqual({ share: 'folder' });
  });
});
