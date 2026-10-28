import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { IntegrationCliTool } from '@gugu/session-plugins/integrations';
import type { CliInstallProgress } from './cli-tool-installer';
import type { CliPlatform } from './cli-tools';

/** Repacked from the pinned vendor binary and Skills, with no install scripts.
 * The role-backed, read-only mount supplies bytes; no URL or credential is sent
 * to the account process. The hash is fixed by this release, not its manifest. */
export const DWS_LINUX_PRODUCT = {
  version: '1.0.64',
  sha256: 'e627928eb11f3ebca00b731fcfd3fa184d91e258ccb6cf4cfb4f8b32d16165ba',
  archiveBytes: 19563250, bin: 'dws', requiredSkill: 'dws/SKILL.md',
};
export function managedProductRoot(tool: IntegrationCliTool, platform: CliPlatform): string | undefined {
  if (process.env.GUGU_CLOUD_COMPUTER !== '1' || tool !== 'dws' || platform !== 'linux-x64') return;
  const root = process.env.GUGU_CLI_PRODUCT_ROOT || '/mnt/gugu-cli-products';
  if (!path.isAbsolute(root)) throw new Error('Managed CLI product root must be absolute');
  return existsSync(path.join(root, `${DWS_LINUX_PRODUCT.sha256}.tgz`)) ? root : undefined;
}

export async function installManagedProduct(
  root: string, product: Pick<typeof DWS_LINUX_PRODUCT, 'sha256' | 'archiveBytes' | 'bin' | 'requiredSkill'>, staging: string,
  report: (p: CliInstallProgress) => void,
): Promise<void> {
  const file = `${product.sha256}.tgz`;
  const download = path.join(staging, 'download');
  await fs.mkdir(download, { recursive: true });
  const archive = path.join(download, file);
  const hash = createHash('sha256'); let receivedBytes = 0;
  const progress = () => report({ phase: 'download', file, receivedBytes, totalBytes: product.archiveBytes });
  progress();
  const checking = new Transform({ transform(chunk: Buffer, _encoding, done) {
    receivedBytes += chunk.length;
    if (receivedBytes > product.archiveBytes) { done(new Error('Managed CLI product integrity mismatch')); return; }
    hash.update(chunk); progress(); done(null, chunk);
  } });
  await pipeline(createReadStream(path.join(root, file)), checking, createWriteStream(archive, { flags: 'wx' }),
    { signal: AbortSignal.timeout(60_000) });
  if (receivedBytes !== product.archiveBytes || hash.digest('hex') !== product.sha256) {
    throw new Error('Managed CLI product integrity mismatch');
  }
  // Only the exact release hash above reaches extraction. The build emits
  // regular bin/skills files only; an altered archive never reaches tar.
  await promisify(execFile)('tar', ['-xzf', archive, '-C', staging], { timeout: 30_000 });
  await fs.access(path.join(staging, 'bin', product.bin));
  await fs.access(path.join(staging, 'skills', product.requiredSkill));
}
