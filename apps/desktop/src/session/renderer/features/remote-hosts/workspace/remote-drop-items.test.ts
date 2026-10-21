import { describe, expect, it } from 'vitest';
import { dropUploadItems, type DropEntry } from './remote-drop-items';

const blob = (name: string, text: string) => Object.assign(new Blob([text]), { name }) as unknown as File;

function fileEntry(name: string, text: string): DropEntry {
  return { isFile: true, isDirectory: false, name, file: (ok) => ok(blob(name, text)) };
}

function dirEntry(name: string, children: DropEntry[]): DropEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      // 与浏览器一样一批批地给(这里一批一个),读到空批才算完。
      const queue = [...children];
      return { readEntries: (ok) => ok(queue.length ? [queue.shift()!] : []) };
    },
  };
}

const items = (entries: DropEntry[]) =>
  ({
    items: entries.map((entry) => ({ kind: 'file', webkitGetAsEntry: () => entry })),
    files: [],
  }) as unknown as DataTransfer;

describe('从访达拖进来的东西 → 要上传的那几件', () => {
  it('文件夹按层展开,路径从拖进来的那一层起;字节按段取', async () => {
    const out = await dropUploadItems(items([dirEntry('site', [fileEntry('index.html', '<h1>'), dirEntry('css', [fileEntry('a.css', 'b{}')])]), fileEntry('notes.md', 'hi')]));
    expect(out.map((item) => [item.segments.join('/'), item.size])).toEqual([
      ['site/index.html', 4],
      ['site/css/a.css', 3],
      ['notes.md', 2],
    ]);
    expect(new TextDecoder().decode(await out[0]!.slice(1, 3))).toBe('h1');
  });

  it('浏览器不给 entry(老路子):退回 files;拖的不是文件 = 空', async () => {
    const fallback = await dropUploadItems({ items: [] as unknown as DataTransferItemList, files: [blob('a.txt', 'x')] as unknown as FileList });
    expect(fallback.map((item) => item.segments)).toEqual([['a.txt']]);
    const text = await dropUploadItems({ items: [{ kind: 'string' }] as unknown as DataTransferItemList, files: [] as unknown as FileList });
    expect(text).toEqual([]);
  });
});
