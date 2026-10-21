import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORKSPACE_CONFLICT_CODE, WORKSPACE_WRITE_FORCE } from '@gugu/session-core/session-record/contract';
import { createWorkspaceUploads, inWorkspace, readWorkspaceChunk } from './workspace-transfer';

let base = '';
let root = '';

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'ws-transfer-'));
  root = path.join(base, 'repo');
  mkdirSync(root);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const b64 = (text: string) => Buffer.from(text).toString('base64');

describe('路径只能落在这个工作区里', () => {
  it('`..` 与绝对路径逃不出去', async () => {
    await expect(inWorkspace(root, '../secret')).rejects.toMatchObject({ code: 'outside_workspace' });
    await expect(inWorkspace(root, '/etc/passwd')).rejects.toMatchObject({ code: 'outside_workspace' });
  });

  it('指向外面的符号链接也挡住(按真实路径再核一次)', async () => {
    writeFileSync(path.join(base, 'secret.txt'), 'x');
    symlinkSync(path.join(base, 'secret.txt'), path.join(root, 'link.txt'));
    await expect(readWorkspaceChunk(root, { path: 'link.txt', offset: 0, length: 10 })).rejects.toMatchObject({
      code: 'outside_workspace',
    });
  });
});

describe('按块读', () => {
  it('读一段,带版本号;越过末尾是空串', async () => {
    writeFileSync(path.join(root, 'a.txt'), 'hello world');
    const first = await readWorkspaceChunk(root, { path: 'a.txt', offset: 6, length: 100 });
    expect(Buffer.from(first.data, 'base64').toString()).toBe('world');
    expect(first.size).toBe(11);
    expect(first.etag).toMatch(/^\d+-11$/);
    const past = await readWorkspaceChunk(root, { path: 'a.txt', offset: 50, length: 10 });
    expect(past.data).toBe('');
  });

  it('不存在 / 是目录:各报各的码', async () => {
    await expect(readWorkspaceChunk(root, { path: 'nope', offset: 0, length: 1 })).rejects.toMatchObject({ code: 'not_found' });
    mkdirSync(path.join(root, 'dir'));
    await expect(readWorkspaceChunk(root, { path: 'dir', offset: 0, length: 1 })).rejects.toMatchObject({ code: 'not_a_file' });
  });
});

describe('按块写,按「打开时那一版」核对', () => {
  it('上限可以由用的那一方给(另一台机器发来的 App 包)', async () => {
    const uploads = createWorkspaceUploads({ maxBytes: 4 });
    await expect(uploads.write(root, { path: 'd.json', uploadId: 'm1', offset: 0, data: b64('12345'), total: 5, final: true, expectedEtag: null }))
      .rejects.toMatchObject({ code: 'too_large' });
    await uploads.write(root, { path: 'd.json', uploadId: 'm2', offset: 0, data: b64('1234'), total: 4, final: true, expectedEtag: null });
    expect(readFileSync(path.join(root, 'd.json'), 'utf8')).toBe('1234');
  });

  it('两段收齐才落盘', async () => {
    const uploads = createWorkspaceUploads();
    const part = { path: 'new.txt', uploadId: 'u1', total: 6, expectedEtag: null };
    expect(await uploads.write(root, { ...part, offset: 0, data: b64('abc'), final: false })).toEqual({ received: 3 });
    const done = await uploads.write(root, { ...part, offset: 3, data: b64('def'), final: true });
    expect(done.committed?.size).toBe(6);
    expect(readFileSync(path.join(root, 'new.txt'), 'utf8')).toBe('abcdef');
  });

  it('agent 在人打开之后改过这个文件 ⇒ 拒(冲突),❌ 静默盖掉;人确认覆盖才写', async () => {
    const file = path.join(root, 'a.txt');
    writeFileSync(file, 'v1');
    const opened = await readWorkspaceChunk(root, { path: 'a.txt', offset: 0, length: 10 });
    writeFileSync(file, 'agent edit');
    const uploads = createWorkspaceUploads();
    await expect(
      uploads.write(root, { path: 'a.txt', uploadId: 'u2', offset: 0, data: b64('mine'), total: 4, final: true, expectedEtag: opened.etag })
    ).rejects.toMatchObject({ code: WORKSPACE_CONFLICT_CODE });
    expect(readFileSync(file, 'utf8')).toBe('agent edit');
    await uploads.write(root, {
      path: 'a.txt',
      uploadId: 'u3',
      offset: 0,
      data: b64('mine'),
      total: 4,
      final: true,
      expectedEtag: WORKSPACE_WRITE_FORCE,
    });
    expect(readFileSync(file, 'utf8')).toBe('mine');
  });

  it('新文件却已经有同名的 ⇒ 冲突', async () => {
    writeFileSync(path.join(root, 'b.txt'), 'x');
    const uploads = createWorkspaceUploads();
    await expect(
      uploads.write(root, { path: 'b.txt', uploadId: 'u4', offset: 0, data: b64('y'), total: 1, final: true, expectedEtag: null })
    ).rejects.toMatchObject({ code: WORKSPACE_CONFLICT_CODE });
  });

  it('第一段丢了(中途重启过)⇒ 让人从头再存一遍', async () => {
    const uploads = createWorkspaceUploads();
    await expect(
      uploads.write(root, { path: 'c.txt', uploadId: 'u5', offset: 3, data: b64('def'), total: 6, final: true, expectedEtag: null })
    ).rejects.toMatchObject({ code: 'upload_lost' });
  });
});
