import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { textFilePatch } from './text-diff';

it.each([
  ['LF', 'one\ntwo\n', 'one\nthree\n'],
  ['CRLF', 'one\r\ntwo\r\n', 'one\r\nthree\r\n'],
  ['no final newline', 'one\ntwo', 'one\nthree'],
  ['add final newline', 'same', 'same\n'],
  ['remove final newline', 'same\n', 'same'],
  ['new file', null, 'new\n'],
  ['new empty file', null, ''],
  ['delete file', 'old\r\n', null],
  ['delete empty file', '', null],
  ['Unicode and empty lines', 'α\n\nβ\n', 'α\n\nγ\n'],
] as const)('encodes %s bytes that independent git apply reconstructs exactly', async (_name, before, after) => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-text-patch-'));
  const path = join(directory, 'file.txt');
  const patchPath = join(directory, 'input.patch');
  try {
    if (before !== null) await writeFile(path, before);
    const patch = textFilePatch('file.txt', before, after, 'file');
    await writeFile(patchPath, patch.patch!.text);
    execFileSync('git', ['apply', patchPath], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
    if (after === null) await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    else expect(await readFile(path, 'utf8')).toBe(after);
  } finally {
    await unlink(patchPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(directory);
  }
});
