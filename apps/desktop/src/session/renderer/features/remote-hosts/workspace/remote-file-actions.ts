import { messageForUser } from '@/lib/userFacingError';
// #6264 别的机器上的文件:下载 / 上传「做完之后说什么」(toast)。动作本身的判断在 remote-transfers.ts 与那台机器上;
// 界面是本机同一棵文件树(editor-file-tree.tsx),它经工作区后端的 tree 那一格走到这里。
import { type SessionpageWorkspaceEntry } from '@gugu/session-core/session-record/contract';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { log } from '@renderer/utils/logger';
import { detectPlatform } from '@tanstack/react-hotkeys';
import { remoteErrorCode } from '../remote-failure-copy';
import { REMOTE_DOWNLOAD_MAX_FILES, type RemoteTransfer, type RemoteTransfers } from './remote-transfers';

const PLATFORM = detectPlatform();
/** 「在访达中显示」按平台换词(与本机文件树同一组文案)。 */
const REVEAL_LABEL_KEY =
  PLATFORM === 'mac' ? 'fileTree.revealFinder' : PLATFORM === 'windows' ? 'fileTree.revealExplorer' : 'fileTree.revealFileManager';

/** 一次传输没成:原因说人话(原因码只进日志)。 */
function transferFailure(transfer: RemoteTransfer): string {
  const code = remoteErrorCode(transfer.error);
  if (code === 'too_many_files') return translateSessionMessage('remoteFiles.tooManyFiles', { count: REMOTE_DOWNLOAD_MAX_FILES });
  if (code === 'changing') return translateSessionMessage('remoteFiles.keptChanging');

  return messageForUser(transfer.error);
}

/** 下载一个文件 / 文件夹到这台电脑;结束时说一句(下好了带「在访达中显示」)。 */
export async function downloadEntry(
  transfers: RemoteTransfers,
  entry: Pick<SessionpageWorkspaceEntry, 'name' | 'path' | 'isDirectory' | 'size'>
): Promise<void> {
  let transfer: RemoteTransfer | null;
  try {
    transfer = await transfers.download(entry);
  } catch (error) {
    log.error('[remote-files] 下载没开始', { error: String(error) });
    toast({ title: translateSessionMessage('remoteFiles.downloadFailed', { name: entry.name }), description: messageForUser(error), tier: 'error' });
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
      description: transferFailure(transfer) || undefined,
      tier: 'error',
    });
  }
}

/** 上传到那台机器上的 `dir`;结束时说一句,超过单件上限被跳过的如实列出。返回有没有真的传了东西。 */
