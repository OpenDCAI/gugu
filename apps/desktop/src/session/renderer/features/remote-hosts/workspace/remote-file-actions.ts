import { messageForUser } from '@/lib/userFacingError';
// #6264 别的机器上的文件:下载「做完之后说什么」(toast)。
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { log } from '@renderer/utils/logger';
import { detectPlatform } from '@tanstack/react-hotkeys';

const PLATFORM = detectPlatform();
/** 「在访达中显示」按平台换词(与本机文件树同一组文案)。 */
const REVEAL_LABEL_KEY =
  PLATFORM === 'mac' ? 'fileTree.revealFinder' : PLATFORM === 'windows' ? 'fileTree.revealExplorer' : 'fileTree.revealFileManager';

/** 别的机器上一个会话的文件存到这台电脑:App 下载的同一条路;结束时说一句(下好了带「在访达中显示」)。 */
export async function downloadSessionFile(sessionId: string, path: string, name: string): Promise<void> {
  const failed = (description?: string) => toast({ title: translateSessionMessage('remoteFiles.downloadFailed', { name }), ...(description ? { description } : {}), tier: 'error' });
  try {
    const result = await rpc.extensions.downloadWorkingCopyFile({ sessionId, path });
    if (!result.success) {
      failed(result.code === 'content-changed' ? translateSessionMessage('remoteFiles.keptChanging') : result.error);
      return;
    }
    const target = result.target;
    if (!target) return;
    toast({
      title: translateSessionMessage('remoteFiles.downloaded', { name }),
      tier: 'success',
      action: { label: translateSessionMessage(REVEAL_LABEL_KEY), onClick: () => void rpc.app.showItemInFolder(target) },
    });
  } catch (error) {
    log.error('[remote-files] 下载没开始', { error: String(error) });
    failed(messageForUser(error));
  }
}
