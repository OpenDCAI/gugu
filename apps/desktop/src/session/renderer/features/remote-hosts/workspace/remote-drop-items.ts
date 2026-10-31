// #6264 从访达拖进别的机器的文件树(或「上传文件…」选的文件)→ 要上传的那几件(remote-transfers 的 UploadItem)。
//
// 拖进来的文件夹按层展开(浏览器的 FileSystemEntry:目录要一批批地读,一批最多百来个);字节 ❌ 一次读进内存,
// 传的时候按段 `slice`。这里只认浏览器给的对象,路径一律是「拖进来的那一层」起的逐层名字。
import type { UploadItem } from './remote-transfers';

/** 浏览器 FileSystemEntry 里用得到的那一小块(单测给假的)。 */
export type DropEntry =
  | { isFile: true; isDirectory: false; name: string; file(success: (file: File) => void, failure?: (error: unknown) => void): void }
  | { isFile: false; isDirectory: true; name: string; createReader(): { readEntries(success: (entries: DropEntry[]) => void, failure?: (error: unknown) => void): void } };

export function fileUploadItem(file: Blob & { name: string }, segments: string[] = [file.name]): UploadItem {
  return {
    segments,
    size: file.size,
    slice: async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer()),
  };
}

async function readAll(entry: Extract<DropEntry, { isDirectory: true }>): Promise<DropEntry[]> {
  const reader = entry.createReader();
  const out: DropEntry[] = [];
  for (;;) {
    const batch = await new Promise<DropEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return out;
    out.push(...batch);
  }
}

async function collect(entry: DropEntry, prefix: string[], out: UploadItem[]): Promise<void> {
  const segments = [...prefix, entry.name];
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
    out.push(fileUploadItem(file, segments));
    return;
  }
  for (const child of await readAll(entry)) await collect(child, segments, out);
}

/** 拖进来的东西(含文件夹,按层展开)。拖的不是文件(文字、页内拖动)= 空。 */
export async function dropUploadItems(dataTransfer: Pick<DataTransfer, 'items' | 'files'>): Promise<UploadItem[]> {
  const entries: DropEntry[] = [];
  for (const item of Array.from(dataTransfer.items ?? [])) {
    if (item.kind !== 'file') continue;
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => unknown }).webkitGetAsEntry?.() as DropEntry | null | undefined;
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) return Array.from(dataTransfer.files ?? []).map((file) => fileUploadItem(file));
  const out: UploadItem[] = [];
  for (const entry of entries) await collect(entry, [], out);
  return out;
}
