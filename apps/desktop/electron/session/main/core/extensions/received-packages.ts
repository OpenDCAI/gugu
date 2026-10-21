import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WORKSPACE_WRITE_FORCE } from '@gugu/session-core/session-record/contract';
import { createWorkspaceUploads } from '../files/workspace-transfer';

/**
 * #7290 An App package the owner's other machine sends here for `app_install { device, source_dir }`: its bytes come
 * over the device channel, part by part (the same chunks a remote file save uses), and land in this machine's temp
 * folder — no storage in between. Named by the sending machine and its upload id, so one machine cannot name another's.
 * It stays for both install calls (the ask, then the install of what the person agreed to) and goes once the install
 * is answered; anything left (the person declined) is swept after an hour, when the next package starts arriving.
 */
export const FOLDER_PACKAGE_MAX_BYTES = 25 * 1024 * 1024;
const KEPT_MS = 60 * 60 * 1000;
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const root = () => path.join(os.tmpdir(), 'gugu-folder-packages-in');

function nameOf(fromDevice: string, uploadId: string): string {
  if (!UPLOAD_ID.test(uploadId)) throw new Error('a package upload id is a uuid');
  return `${createHash('sha256').update(fromDevice).digest('hex').slice(0, 16)}-${uploadId}.guguext`;
}

let uploads: ReturnType<typeof createWorkspaceUploads> | null = null;

export async function receivePackagePart(
  fromDevice: string,
  part: { upload_id: string; offset: number; total: number; final: boolean; data: string },
): Promise<{ received: number }> {
  const name = nameOf(fromDevice, part.upload_id);
  fs.mkdirSync(root(), { recursive: true });
  if (part.offset === 0) sweep();
  uploads ??= createWorkspaceUploads({ maxBytes: FOLDER_PACKAGE_MAX_BYTES });
  const { received } = await uploads.write(root(), {
    path: name,
    uploadId: name,
    offset: part.offset,
    total: part.total,
    final: part.final,
    data: part.data,
    expectedEtag: WORKSPACE_WRITE_FORCE,
  });
  return { received };
}

export function readReceivedPackage(fromDevice: string, uploadId: string): Uint8Array {
  const file = path.join(root(), nameOf(fromDevice, uploadId));
  if (!fs.existsSync(file)) throw new Error('the App package from the other machine is not here (it never arrived, or it was already installed); install it again');
  return new Uint8Array(fs.readFileSync(file));
}

export function dropReceivedPackage(fromDevice: string, uploadId: string): void {
  fs.rmSync(path.join(root(), nameOf(fromDevice, uploadId)), { force: true });
}

function sweep(): void {
  const now = Date.now();
  for (const entry of fs.readdirSync(root())) {
    const file = path.join(root(), entry);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (stat && now - stat.mtimeMs > KEPT_MS) fs.rmSync(file, { force: true });
  }
}
