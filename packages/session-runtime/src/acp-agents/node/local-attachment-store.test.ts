import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalAttachmentStore } from './local-attachment-store';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'emdash-attachments-'));
  roots.push(root);
  return root;
}

describe('LocalAttachmentStore', () => {
  /**
   * #5269,owner 2026-09-10:「正确的收敛是一律存一份」。这条从前的写法是
   * 「有原路径就**不**拷贝」,判据甚至反过来断言 objects 目录下不该有那个文件 ——
   * 于是用户把原文件挪走,消息里那张图当场消失。
   */
  it('给了原路径也照样存一份,原文件挪走之后仍然取得到', async () => {
    const root = await makeRoot();
    const sourcePath = join(root, 'source.png');
    await writeFile(sourcePath, new Uint8Array([1, 2, 3]));

    const store = new LocalAttachmentStore(join(root, 'store'));
    const ref = await store.put({
      originalPath: sourcePath,
      mimeType: 'image/png',
      name: 'source.png',
    });

    // 副本真的落在我们自己的地盘上 —— 这一格从前断言的是它**不该**存在。
    await expect(readFile(join(root, 'store', 'objects', ref.id))).resolves.toEqual(
      Buffer.from([1, 2, 3])
    );

    // 判假的那一半:把用户那个原文件删掉,取字节必须照旧成功。
    await rm(sourcePath);
    await expect(store.get(ref.id)).resolves.toEqual({ ref, data: new Uint8Array([1, 2, 3]) });
  });

  it('❌ 既没有字节也没有路径 —— 响亮地拒绝,不落一条取不出东西的记录', async () => {
    const store = new LocalAttachmentStore(join(await makeRoot(), 'store'));
    await expect(store.put({ mimeType: 'image/png', name: 'x.png' })).rejects.toThrow(
      /bytes or a path/
    );
  });

  it('copies uploaded bytes when no original path is provided', async () => {
    const root = await makeRoot();
    const store = new LocalAttachmentStore(join(root, 'store'));

    const ref = await store.put({
      data: new Uint8Array([4, 5, 6]),
      mimeType: 'image/webp',
      name: 'copy.webp',
    });

    await expect(readFile(join(root, 'store', 'objects', ref.id))).resolves.toEqual(
      Buffer.from([4, 5, 6])
    );
    await expect(store.get(ref.id)).resolves.toEqual({
      ref,
      data: new Uint8Array([4, 5, 6]),
    });
  });

  it('persists the index across store instances', async () => {
    const root = await makeRoot();
    const sourcePath = join(root, 'source.jpg');
    await writeFile(sourcePath, new Uint8Array([7, 8, 9]));
    const storeDir = join(root, 'store');

    const ref = await new LocalAttachmentStore(storeDir).put({
      originalPath: sourcePath,
      mimeType: 'image/jpeg',
      name: 'source.jpg',
    });

    await expect(new LocalAttachmentStore(storeDir).get(ref.id)).resolves.toEqual({
      ref,
      data: new Uint8Array([7, 8, 9]),
    });
  });

  it('取不到字节时回 null,❌ 不抛 —— 消息里退回占位块,而不是整条画不出来', async () => {
    // 阴控:副本被外部清掉(用户手动删了 userData)。
    const root = await makeRoot();
    const store = new LocalAttachmentStore(join(root, 'store'));
    const ref = await store.put({
      data: new Uint8Array([1]),
      mimeType: 'image/gif',
      name: 'source.gif',
    });

    await rm(join(root, 'store', 'objects', ref.id));

    await expect(store.get(ref.id)).resolves.toBeNull();
  });

  it('副本在但读不了(权限)就照实抛,❌ 吞成「找不到」', async () => {
    const root = await makeRoot();
    const store = new LocalAttachmentStore(join(root, 'store'));
    const ref = await store.put({ data: new Uint8Array([1]), mimeType: 'image/png', name: 'locked.png' });
    const object = join(root, 'store', 'objects', ref.id);
    await chmod(object, 0o000);
    try {
      await expect(store.get(ref.id)).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      await chmod(object, 0o600);
    }
  });

  it('2026-09-10(#5269)以前的 reference 记录不再读', async () => {
    const root = await makeRoot();
    const sourcePath = join(root, 'source.png');
    await writeFile(sourcePath, new Uint8Array([1, 2, 3]));
    const storeDir = join(root, 'store');
    await mkdir(storeDir, { recursive: true });
    const old = {
      ref: { id: 'old-ref', name: 'source.png', mimeType: 'image/png' },
      createdAt: 1,
      source: { kind: 'reference', originalPath: sourcePath, size: 3, mtimeMs: 1 },
    };
    await writeFile(join(storeDir, 'index.json'), JSON.stringify([old]));

    // 原文件明明还在,也取不到:旧格式整个不认了(owner 2026-10-17 接受)。
    await expect(new LocalAttachmentStore(storeDir).get('old-ref')).resolves.toBeNull();
  });

  it('删掉一件附件不碰用户自己那个原文件', async () => {
    const root = await makeRoot();
    const sourcePath = join(root, 'source.png');
    await writeFile(sourcePath, new Uint8Array([1, 2, 3]));
    const store = new LocalAttachmentStore(join(root, 'store'));
    const ref = await store.put({
      originalPath: sourcePath,
      mimeType: 'image/png',
      name: 'source.png',
    });

    await store.delete(ref.id);

    // 删的是我们那一份;用户盘上那个一个字节都不许动。
    await expect(readFile(sourcePath)).resolves.toEqual(Buffer.from([1, 2, 3]));
    await expect(access(join(root, 'store', 'objects', ref.id))).rejects.toThrow();
    await expect(store.get(ref.id)).resolves.toBeNull();
  });

  it('deletes copied bytes for copy records', async () => {
    const root = await makeRoot();
    const store = new LocalAttachmentStore(join(root, 'store'));
    const ref = await store.put({
      data: new Uint8Array([1, 2, 3]),
      mimeType: 'image/png',
      name: 'copy.png',
    });

    await store.delete(ref.id);

    await expect(access(join(root, 'store', 'objects', ref.id))).rejects.toThrow();
    await expect(store.get(ref.id)).resolves.toBeNull();
  });
});
