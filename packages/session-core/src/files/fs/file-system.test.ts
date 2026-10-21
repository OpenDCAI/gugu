import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSystem } from './file-system';

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const items: string[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'emdash-core-fs-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('FileSystem', () => {
  it('lists a directory, resolving symlinks to their target type', async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, 'sub'));
    await writeFile(path.join(root, 'file.txt'), 'abc', 'utf8');
    await writeFile(path.join(root, '.hidden'), 'x', 'utf8');
    await symlink(path.join(root, 'sub'), path.join(root, 'link-to-dir'));
    const fs = new FileSystem();

    const listing = await fs.readDirectory(root);
    expect(listing.success).toBe(true);
    if (!listing.success) return;

    const byName = new Map(listing.data.map((entry) => [path.basename(entry.path), entry]));
    expect([...byName.keys()].sort()).toEqual(['.hidden', 'file.txt', 'link-to-dir', 'sub']);
    expect(byName.get('sub')?.type).toBe('directory');
    expect(byName.get('link-to-dir')?.type).toBe('directory');
    expect(byName.get('file.txt')?.type).toBe('file');
    expect(byName.get('file.txt')?.size).toBe(3);
  });

  it('drops children it cannot stat instead of failing the whole listing', async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, 'keep.txt'), 'ok', 'utf8');
    // Dangling symlink: readdir sees it, stat never resolves it. One of these
    // must not make the directory unbrowsable.
    await symlink(path.join(root, 'nowhere'), path.join(root, 'dangling'));
    await symlink(path.join(root, 'loop'), path.join(root, 'loop'));
    const fs = new FileSystem();

    const listing = await fs.readDirectory(root);
    expect(listing.success).toBe(true);
    if (!listing.success) return;
    expect(listing.data.map((entry) => path.basename(entry.path))).toEqual(['keep.txt']);
  });

  it('fails when the directory itself cannot be read', async () => {
    const root = await makeRoot();
    const fs = new FileSystem();

    const listing = await fs.readDirectory(path.join(root, 'no-such-dir'));
    expect(listing.success).toBe(false);
  });

  it('refuses a file over the limit instead of handing back half of it', async () => {
    const root = await makeRoot();
    const filePath = path.join(root, 'file.txt');
    await writeFile(filePath, 'hello world', 'utf8');
    const fs = new FileSystem();

    // 超限:只回大小,正文为空 —— 半截正文没有调用点要,拿到手只会被当成完整内容用。
    const text = await fs.readText(filePath, { maxBytes: 5 });
    expect(text.success).toBe(true);
    if (!text.success) return;
    expect(text.data).toEqual({ content: '', truncated: true, totalSize: 11 });

    const overLimit = await fs.readBytes(filePath, { maxBytes: 5 });
    expect(overLimit.success).toBe(true);
    if (!overLimit.success) return;
    expect(overLimit.data.bytes.length).toBe(0);
    expect(overLimit.data.truncated).toBe(true);
    expect(overLimit.data.totalSize).toBe(11);

    // 限内:整份读回来。
    const bytes = await fs.readBytes(filePath, { maxBytes: 20 });
    expect(bytes.success).toBe(true);
    if (!bytes.success) return;
    expect(Buffer.from(bytes.data.bytes).toString('utf8')).toBe('hello world');
    expect(bytes.data.truncated).toBe(false);
  });

  it('marks NUL-containing and invalid UTF-8 files as binary without decoding them', async () => {
    const root = await makeRoot();
    const fs = new FileSystem();
    const nulPath = path.join(root, 'unknown.data');
    const invalidUtf8Path = path.join(root, 'unknown.payload');
    const textPath = path.join(root, 'unknown.note');
    await writeFile(nulPath, Buffer.from([0x41, 0x00, 0x42]));
    await writeFile(invalidUtf8Path, Buffer.from([0xc3, 0x28]));
    await writeFile(textPath, '中文 text', 'utf8');

    await expect(fs.readText(nulPath)).resolves.toMatchObject({
      success: true,
      data: { content: '', binary: true },
    });
    await expect(fs.readText(invalidUtf8Path)).resolves.toMatchObject({
      success: true,
      data: { content: '', binary: true },
    });
    await expect(fs.readText(textPath)).resolves.toMatchObject({
      success: true,
      data: { content: '中文 text' },
    });
  });

  it('writes files inside the root and creates parent directories', async () => {
    const root = await makeRoot();
    const fs = new FileSystem();
    const filePath = path.join(root, 'src/index.ts');

    const written = await fs.writeText(filePath, 'export {};');
    expect(written.success).toBe(true);
    if (!written.success) return;
    expect(written.data.bytesWritten).toBe(Buffer.byteLength('export {};'));
    await expect(readFile(path.join(root, 'src/index.ts'), 'utf8')).resolves.toBe('export {};');
  });

  it('rejects relative paths', async () => {
    const fs = new FileSystem();

    await expect(fs.writeText('../file.txt', 'x')).resolves.toMatchObject({
      success: false,
      error: { type: 'invalid-path' },
    });
  });

  it('stats, checks existence, copies, and removes files', async () => {
    const root = await makeRoot();
    const srcPath = path.join(root, 'src/a.txt');
    const destPath = path.join(root, 'dest/b.txt');
    await mkdir(path.dirname(srcPath));
    await writeFile(srcPath, 'a', 'utf8');
    const fs = new FileSystem();

    const stat = await fs.stat(srcPath);
    expect(stat.success).toBe(true);
    if (!stat.success) return;
    expect(stat.data).toMatchObject({ path: srcPath, type: 'file', size: 1 });

    await expect(fs.exists(srcPath)).resolves.toEqual({ success: true, data: true });
    await expect(fs.copyFile(srcPath, destPath)).resolves.toEqual({
      success: true,
      data: undefined,
    });
    await expect(readFile(destPath, 'utf8')).resolves.toBe('a');
    await expect(fs.remove(srcPath)).resolves.toEqual({ success: true, data: undefined });
    await expect(fs.exists(srcPath)).resolves.toEqual({ success: true, data: false });
  });

  it('removes a symlink to a directory without removing the target directory', async () => {
    const root = await makeRoot();
    const targetDir = path.join(root, 'target');
    const linkPath = path.join(root, 'link');
    await mkdir(targetDir);
    await writeFile(path.join(targetDir, 'file.txt'), 'target', 'utf8');
    try {
      await symlink(targetDir, linkPath, 'dir');
    } catch {
      // Some environments disallow symlink creation.
      return;
    }
    const fs = new FileSystem();

    await expect(fs.remove(linkPath)).resolves.toEqual({ success: true, data: undefined });
    await expect(readFile(path.join(targetDir, 'file.txt'), 'utf8')).resolves.toBe('target');
    await expect(fs.exists(linkPath)).resolves.toEqual({ success: true, data: false });
  });

  it('rejects empty paths', async () => {
    const fs = new FileSystem();

    await expect(fs.remove('')).resolves.toMatchObject({
      success: false,
      error: { type: 'invalid-path' },
    });
    await expect(fs.exists('')).resolves.toMatchObject({
      success: false,
      error: { type: 'invalid-path' },
    });
  });

  it('streams ignore-free glob matches including dotfiles', async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, '.cursor', 'rules'), { recursive: true });
    await mkdir(path.join(root, '.claude'), { recursive: true });
    await writeFile(path.join(root, '.cursor', 'rules', 'style.md'), 'rules', 'utf8');
    await writeFile(path.join(root, '.claude.json'), '{}', 'utf8');
    await writeFile(path.join(root, '.claude', 'settings.json'), '{}', 'utf8');
    const fs = new FileSystem();

    const matched = fs.glob(['.cursor/**', '.claude.json', '.claude/**'], { cwd: root, dot: true });
    expect(matched.success).toBe(true);
    if (!matched.success) return;

    const paths: string[] = [];
    for await (const absPath of matched.data) paths.push(path.relative(root, absPath));
    expect(paths.sort()).toEqual([
      '.claude',
      '.claude.json',
      '.claude/settings.json',
      '.cursor',
      '.cursor/rules',
      '.cursor/rules/style.md',
    ]);
  });

  it('enumerates files recursively', async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src/index.ts'), 'content', 'utf8');
    await writeFile(path.join(root, '.env'), 'env', 'utf8');
    const fs = new FileSystem();

    const enumeration = fs.enumerate(root);
    expect(enumeration.success).toBe(true);
    if (!enumeration.success) return;

    const canonicalRoot = await realpath(root);
    await expect(collect(enumeration.data)).resolves.toEqual([
      path.join(canonicalRoot, '.env'),
      path.join(canonicalRoot, 'src/index.ts'),
    ]);
  });

  it('rejects relative roots for enumerate', () => {
    const fs = new FileSystem();

    expect(fs.enumerate('relative-root')).toMatchObject({
      success: false,
      error: { type: 'invalid-path' },
    });
  });
});
