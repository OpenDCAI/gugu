import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { toast } from '@renderer/lib/hooks/use-toast';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { isHeicLikeFile, mustCopyRatherThanReference } from './terminal-image-paths';
import { electronApi } from '../electron-api';

const MAX_DROPPED_BLOB_BYTES = 50 * 1024 * 1024;

export async function resolveDroppedFile(file: File, directory = false): Promise<string | null> {
  const originalPath = electronApi().getPathForFile(file).trim();
  // 文件夹读不出字节,也本就是要 agent 在原处干活:照原路径给。
  if (directory) return originalPath || null;
  if (originalPath && !mustCopyRatherThanReference(originalPath) && !isHeicLikeFile(file)) {
    return originalPath;
  }
  // 存不下一份就当场说(#985):原路径不能给,❌ 静默丢掉、或退回去把原路径敲进终端。
  const notKept = (): null => {
    toast({ title: translateSessionMessage('terminal.fileCopyFailed', { name: file.name || originalPath }), tier: 'error' });
    return null;
  };
  if (file.size > MAX_DROPPED_BLOB_BYTES) {
    log.warn('Dropped file is too large to persist', { size: file.size, name: file.name });
    return notKept();
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await rpc.pty.persistDroppedBlob({
      bytes,
      name: file.name,
      mimeType: file.type,
    });
    if (result.success) return result.data.path;
    log.warn('Dropped file persist failed', { error: result.error });
  } catch (error) {
    log.warn('Dropped file arrayBuffer failed', { error });
  }
  return notKept();
}
