import { describe, expect, it } from 'vitest';
import type { IFileSystem } from '@gugu/session-core/files';
import { OFFICE_KINDS } from '@renderer/lib/editor/fileKind';
import { readInlineBinaryDataUrl } from './image-support';

const fileSystem = {
  readBytes: async () => ({
    success: true as const,
    data: { bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]), truncated: false, totalSize: 4 },
  }),
} as unknown as IFileSystem;

/**
 * #7191 真机:会话页认得 .xlsx、自己去取字节,主进程这份名单却没有它 → 页签里只剩一行
 * 「Unsupported inline format: .xlsx」。两边由同一张表连起来:渲染层每种「自己取字节」的文档,这里都得肯递。
 */
describe('#7191 渲染层自己取字节的文档,主进程都肯递', () => {
  it.each(['pdf', ...Object.keys(OFFICE_KINDS)])('.%s', async (ext) => {
    const result = await readInlineBinaryDataUrl(fileSystem, `/w/a.${ext}`);
    expect(result.success && result.data.success).toBe(true);
  });

  it('画不出来的老格式照旧拒(它们走「用系统默认程序打开」)', async () => {
    const result = await readInlineBinaryDataUrl(fileSystem, '/w/a.xls');
    expect(result.success && result.data.success).toBe(false);
  });
});
