import { messageForUser } from '@/lib/userFacingError';
// #6264 别的机器上的文件:下载 / 上传「做完之后说什么」(toast)。动作本身的判断在 remote-transfers.ts 与那台机器上;
// 界面是本机同一棵文件树(editor-file-tree.tsx),它经工作区后端的 tree 那一格走到这里。
import { REMOTE_WORKSPACE_MAX_FILE_BYTES, type SessionpageWorkspaceEntry } from '@gugu/session-core/session-record/contract';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { formatBytes } from '@renderer/utils/formatBytes';
import { log } from '@renderer/utils/logger';
import { detectPlatform } from '@tanstack/react-hotkeys';
import { remoteErrorCode } from '../remote-failure-copy';
import { LOCAL_WRITE_FAILED } from './remote-transfer-wiring';
import { REMOTE_DOWNLOAD_MAX_FILES, type RemoteTransfer, type RemoteTransfers, type UploadItem } from './remote-transfers';

const PLATFORM = detectPlatform();
/** 「在访达中显示」按平台换词(与本机文件树同一组文案)。 */
const REVEAL_LABEL_KEY =
  PLATFORM === 'mac' ? 'fileTree.revealFinder' : PLATFORM === 'windows' ? 'fileTree.revealExplorer' : 'fileTree.revealFileManager';

/** 一次传输没成:原因说人话(原因码只进日志)。 */
function transferFailure(transfer: RemoteTransfer, describe: (error: unknown) => string): string {
  const code = remoteErrorCode(transfer.error);
  if (code === 'too_many_files') return translateSessionMessage('remoteFiles.tooManyFiles', { count: REMOTE_DOWNLOAD_MAX_FILES });
  if (code === 'changing') return translateSessionMessage('remoteFiles.keptChanging');
  if (code === LOCAL_WRITE_FAILED) {
    // 这台电脑这一侧落盘出的错(磁盘满、没权限):原文进日志,标题那句「没下载下来」就够了。
    log.warn('[remote-files] 下载落盘失败', { error: String(transfer.error) });
    return '';
  }
  return describe(transfer.error);
}

/** 下载一个文件 / 文件夹到这台电脑;结束时说一句(下好了带「在访达中显示」)。 */
export async function downloadEntry(
  transfers: RemoteTransfers,
  entry: Pick<SessionpageWorkspaceEntry, 'name' | 'path' | 'isDirectory' | 'size'>,
  describe: (error: unknown) => string
): Promise<void> {
  let transfer: RemoteTransfer | null;
  try {
    transfer = await transfers.download(entry);
  } catch (error) {
    log.error('[remote-files] 下载没开始', { error: String(error) });
    toast({ title: messageForUser(error), tier: 'error' });
    return;
  }
  if (!transfer) return;
  // 进度行只画正在传的;结束了就交给下面这句话。
  transfers.dismiss(transfer);
  if (transfer.status === 'done') {
    const target = transfer.target;
    toast({
      title: translateSessionMessage('remoteFiles.downloaded', { name: entry.name }),
      tier: 'success',
      ...(target
        ? { action: { label: translateSessionMessage(REVEAL_LABEL_KEY), onClick: () => void rpc.app.showItemInFolder(target) } }
        : {}),
    });
  } else if (transfer.status === 'failed') {
    toast({
      title: translateSessionMessage('remoteFiles.downloadFailed', { name: entry.name }),
      description: transferFailure(transfer, describe) || undefined,
      tier: 'error',
    });
  }
}

/** 上传到那台机器上的 `dir`;结束时说一句,超过单件上限被跳过的如实列出。返回有没有真的传了东西。 */
export async function uploadItems(
  transfers: RemoteTransfers,
  dir: string,
  items: UploadItem[],
  device: string,
  describe: (error: unknown) => string
): Promise<boolean> {
  if (items.length === 0) return false;
  const tops = [...new Set(items.map((item) => item.segments[0]!))];
  const label = tops.length === 1 ? tops[0]! : translateSessionMessage('remoteFiles.itemCount', { count: tops.length });
  let transfer: RemoteTransfer | null;
  try {
    transfer = await transfers.upload(dir, items, label);
  } catch (caught) {
    toast({ title: translateSessionMessage('remoteFiles.uploadFailed', { name: label, device }), description: describe(caught), tier: 'error' });
    return false;
  }
  if (!transfer) return false;
  transfers.dismiss(transfer);
  const skipped = transfer.skipped.length
    ? translateSessionMessage('remoteFiles.skipped', { limit: formatBytes(REMOTE_WORKSPACE_MAX_FILE_BYTES), names: transfer.skipped.join(', ') })
    : undefined;
  if (transfer.status === 'done') {
    toast({ title: translateSessionMessage('remoteFiles.uploaded', { name: label, device }), description: skipped, tier: skipped ? 'warning' : 'success' });
  } else if (transfer.status === 'failed') {
    toast({
      title: translateSessionMessage('remoteFiles.uploadFailed', { name: label, device }),
      description: transferFailure(transfer, describe) || skipped,
      tier: 'error',
    });
  }
  return transfer.status === 'done';
}
