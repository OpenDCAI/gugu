import { mkdtemp, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diskFileStamp } from './windows-launcher';

/**
 * #7081:就地升级是「路径不变、文件换了」—— stamp 必须认得出来,没换时又必须不变。
 * 全程真目录、真软链接、真覆盖,❌ 不 mock fs:被测的就是「读盘读到了什么」。
 */
describe('diskFileStamp —— 这条路径此刻是哪一份文件', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gugu-file-stamp-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * 原生安装器的升级:`~/.local/bin/claude` 改指 `versions/<新版本>`。
   * 两份版本特意做成同长、mtime 拨到同一刻 —— 只剩「指着哪一份」能分辨;stamp 只看 mtime + size 时这条必红。
   * Windows 上建软链接要开发者模式 / 管理员,那里不跑这一条。
   */
  it.skipIf(process.platform === 'win32')('改软链接指向 → stamp 变(两份同长同 mtime 也认得出)', async () => {
    const before280 = join(dir, '2.1.280');
    const after296 = join(dir, '2.1.296');
    await writeFile(before280, 'claude 2.1.280');
    await writeFile(after296, 'claude 2.1.296');
    const sameMoment = new Date('2026-10-10T02:53:00Z');
    await utimes(before280, sameMoment, sameMoment);
    await utimes(after296, sameMoment, sameMoment);
    const link = join(dir, 'claude');
    await symlink(before280, link);
    const before = diskFileStamp(link);

    await unlink(link);
    await symlink(after296, link);

    expect(before).not.toBeNull();
    expect(diskFileStamp(link)).not.toBe(before);
  });

  /** npm / brew 的升级:同一条路径上的文件被原地覆盖。内容特意同长,只剩 mtime 能分辨。 */
  it('原地覆盖 → stamp 变', async () => {
    const cli = join(dir, 'cli.js');
    await writeFile(cli, 'v1');
    const yesterday = new Date(Date.now() - 24 * 60 * 60_000);
    await utimes(cli, yesterday, yesterday);
    const before = diskFileStamp(cli);

    await writeFile(cli, 'v2');

    expect(before).not.toBeNull();
    expect(diskFileStamp(cli)).not.toBe(before);
  });

  it.skipIf(process.platform === 'win32')('没动过 → stamp 不变(否则拿它当键的缓存就成了摆设)', async () => {
    const target = join(dir, '2.1.296');
    await writeFile(target, 'claude 2.1.296');
    const link = join(dir, 'claude');
    await symlink(target, link);

    expect(diskFileStamp(link)).not.toBeNull();
    expect(diskFileStamp(link)).toBe(diskFileStamp(link));
  });

  it.skipIf(process.platform === 'win32')('读不到 → null(路径不存在、软链接悬空)', async () => {
    const dangling = join(dir, 'claude');
    await symlink(join(dir, 'removed-version'), dangling);

    expect(diskFileStamp(join(dir, 'missing'))).toBeNull();
    expect(diskFileStamp(dangling)).toBeNull();
  });
});
