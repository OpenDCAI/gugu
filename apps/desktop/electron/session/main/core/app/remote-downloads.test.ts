import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRemoteDownloads, freeName } from './remote-downloads';

const b64 = (text: string) => Buffer.from(text).toString('base64');

describe('下载别的机器上的文件到这台电脑', () => {
  let dir: string;
  let asked: string[];

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), 'gugu-dl-')));
    asked = [];
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const downloads = (choice: 'accept' | 'cancel' = 'accept') =>
    createRemoteDownloads(
      {
        saveFile: async (defaultPath) => {
          asked.push(defaultPath);
          return choice === 'accept' ? defaultPath : undefined;
        },
        pickDirectory: async (defaultPath) => {
          asked.push(defaultPath);
          return choice === 'accept' ? defaultPath : undefined;
        },
        downloadsDir: () => dir,
      },
      () => 'tok'
    );

  it('单个文件:另存为默认落在「下载」文件夹,分段写完就是原文', async () => {
    const d = downloads();
    const started = await d.begin({ name: 'report.md', kind: 'file' });
    expect(started).toEqual({ token: 'tok', target: path.join(dir, 'report.md') });
    expect(asked).toEqual([path.join(dir, 'report.md')]);
    await d.write({ token: 'tok', segments: [], offset: 0, data: b64('hello '), final: false });
    await d.write({ token: 'tok', segments: [], offset: 6, data: b64('world'), final: true });
    expect(await d.finish({ token: 'tok', ok: true })).toBe(path.join(dir, 'report.md'));
    expect(await readFile(path.join(dir, 'report.md'), 'utf8')).toBe('hello world');
    expect(d.pending()).toBe(0);
  });

  it('文件夹:选的目录里建一个同名文件夹(已有就编号),里面按层落', async () => {
    await writeFile(path.join(dir, 'site'), 'occupied');
    const d = downloads();
    const started = await d.begin({ name: 'site', kind: 'folder' });
    expect(started?.target).toBe(path.join(dir, 'site (1)'));
    await d.write({ token: 'tok', segments: ['css', 'a.css'], offset: 0, data: b64('body{}'), final: true });
    await d.write({ token: 'tok', segments: ['index.html'], offset: 0, data: b64(''), final: true });
    await d.finish({ token: 'tok', ok: true });
    expect(await readFile(path.join(dir, 'site (1)', 'css', 'a.css'), 'utf8')).toBe('body{}');
    expect((await readdir(path.join(dir, 'site (1)'))).sort()).toEqual(['css', 'index.html']);
  });

  it('写不出落点:.. 与分隔符一律拒;段落接不上就拒', async () => {
    const d = downloads();
    await d.begin({ name: 'site', kind: 'folder' });
    await expect(d.write({ token: 'tok', segments: ['..', 'evil'], offset: 0, data: '', final: true })).rejects.toThrow('bad path');
    await expect(d.write({ token: 'tok', segments: ['a/b'], offset: 0, data: '', final: true })).rejects.toThrow('bad path');
    await expect(d.write({ token: 'tok', segments: [], offset: 0, data: '', final: true })).rejects.toThrow('bad path');
    await d.write({ token: 'tok', segments: ['x'], offset: 0, data: b64('ab'), final: false });
    await expect(d.write({ token: 'tok', segments: ['x'], offset: 5, data: b64('c'), final: true })).rejects.toThrow('missing earlier parts');
    await expect(d.begin({ name: '../x', kind: 'file' })).rejects.toThrow('invalid name');
  });

  it('失败 / 取消:写了一半的东西删掉;人在对话框里取消 = 什么都不做', async () => {
    const d = downloads();
    await d.begin({ name: 'big.bin', kind: 'file' });
    await d.write({ token: 'tok', segments: [], offset: 0, data: b64('half'), final: false });
    expect(await d.finish({ token: 'tok', ok: false })).toBeNull();
    await expect(readFile(path.join(dir, 'big.bin'))).rejects.toThrow();
    expect(await downloads('cancel').begin({ name: 'x', kind: 'file' })).toBeNull();
  });

  it('编号与浏览器下载同一种:报告.pdf → 报告 (1).pdf', async () => {
    await writeFile(path.join(dir, '报告.pdf'), '');
    expect(await freeName(dir, '报告.pdf')).toBe(path.join(dir, '报告 (1).pdf'));
  });
});
