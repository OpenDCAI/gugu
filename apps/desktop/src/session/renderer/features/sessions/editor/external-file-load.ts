import type { ManagedFileKind } from '@renderer/lib/editor/types';
import type { rpc } from '@renderer/lib/ipc';
import type { FileTabResource } from './stores/file-tab-resource';

type ReadImageResult = Awaited<ReturnType<typeof rpc.workspace.files.readImage>>;
type ReadExternalFileResult = Awaited<ReturnType<typeof rpc.workspace.files.readExternalFile>>;

/** The two main-process readers a file outside the workspace can go through. */
export interface ExternalFileReaders {
  readImage: (path: string) => Promise<ReadImageResult>;
  readExternalFile: (path: string, maxBytes: number) => Promise<ReadExternalFileResult>;
}

/** What reading a file outside the workspace produced, before it is written onto the tab. */
export type ExternalFileLoad =
  | { kind: 'image'; dataUrl: string }
  | { kind: 'image-error'; message: string }
  | { kind: 'text'; content: string }
  | { kind: 'binary' }
  | { kind: 'too-large'; totalSize: number }
  | { kind: 'error'; message: string };

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String(error.message);
  }
  if (typeof error === 'string') return error;
  return 'File system unavailable';
}

/**
 * 读一份工作区外的文件,按类型走对的那条读取(#6455)。
 *
 * 这些 tab 不进 model manager(`FileTabResource` 的 `_usesModels` 只放行文本类),正文由
 * `FileContentPreview` 这一跳来取。图片 ❌ 走 `readExternalFile`:那条按文本读,读到二进制只回一个
 * `binary`,图片就被画成「不支持的文件格式」。图片和工作区内的图片走同一个 `readImage` ——
 * 主进程那头对绝对路径按原样读(#5814)。
 */
export async function readExternalFileForTab(
  fileKind: ManagedFileKind,
  path: string,
  maxBytes: number,
  readers: ExternalFileReaders
): Promise<ExternalFileLoad> {
  if (fileKind === 'image') {
    try {
      const result = await readers.readImage(path);
      if (!result.success) return { kind: 'image-error', message: errorMessage(result.error) };
      if (!result.data.success) return { kind: 'image-error', message: result.data.error };
      return { kind: 'image', dataUrl: result.data.dataUrl };
    } catch (error) {
      return { kind: 'image-error', message: errorMessage(error) };
    }
  }

  try {
    const result = await readers.readExternalFile(path, maxBytes);
    if (!result.success) return { kind: 'error', message: errorMessage(result.error) };
    if (result.data.binary) return { kind: 'binary' };
    // 读不完整就说读不完整(#5750):半截正文渲染出来和完整的长得一样,没人看得出来。
    if (result.data.truncated) return { kind: 'too-large', totalSize: result.data.totalSize };
    return { kind: 'text', content: result.data.content };
  } catch (error) {
    return { kind: 'error', message: errorMessage(error) };
  }
}

/** Writes a finished read onto the tab. Call inside a MobX action. */
export function applyExternalFileLoad(tab: FileTabResource, load: ExternalFileLoad): void {
  switch (load.kind) {
    case 'image':
      tab.setImageContent(load.dataUrl);
      return;
    case 'image-error':
      // 读不出来的图要说读不出来:留在 image 上只会画一张空图,和「图就是白的」分不开。
      tab.setContentType('file-error');
      tab.setExternalError(load.message);
      return;
    case 'text':
      tab.setExternalContent(load.content);
      return;
    case 'binary':
      tab.setExternalBinary();
      return;
    case 'too-large':
      tab.setExternalTooLarge(load.totalSize);
      return;
    case 'error':
      tab.setExternalError(load.message);
      return;
  }
}
