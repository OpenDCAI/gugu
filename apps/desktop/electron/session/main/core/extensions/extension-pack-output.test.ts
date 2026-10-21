import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 摩擦单 F12(L6 S6):agent 给 app_pack 传了一个 output_path(工具以前不收),报错后又重试一次。
 * 现在 output_path 可选:不给就写在 App 文件夹旁边并回报实际路径;给了,.guguext 结尾是文件、别的是文件夹,缺的目录建出来。
 * 这里只判「写到哪」:打包本身(检查与字节)由 extension-archive 负责,这里换成假的。
 */
vi.mock('@main/core/extensions/extensions-root', () => ({ extensionsService: () => ({}) }));
vi.mock('./extension-archive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./extension-archive')>()),
  packExtensionArchive: vi.fn(async () => ({
    bytes: new TextEncoder().encode('guguext-bytes'),
    sha256: 'f'.repeat(64),
    manifest: { id: 'dinner-vote', version: '1.2.0' },
  })),
}));

const { runExtensionAgentAction } = await import('./extension-agent-actions');

let work: string;
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'gugu-pack-out-'));
  mkdirSync(path.join(work, 'apps', 'dinner-vote'), { recursive: true });
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const pack = (output_path?: string) =>
  runExtensionAgentAction(
    { action: 'pack', source_dir: 'apps/dinner-vote', ...(output_path === undefined ? {} : { output_path }) },
    { callerWorkspaceRoot: async () => work },
  ) as Promise<{ file_path: string; file_name: string }>;

describe('app_pack: where the .guguext goes', () => {
  it('without output_path: next to the bundle folder, and the answer says where', async () => {
    const packed = await pack();
    expect(packed.file_path).toBe(path.join(work, 'apps', 'dinner-vote-1.2.0.guguext'));
    expect(readFileSync(packed.file_path, 'utf8')).toBe('guguext-bytes');
  });

  it('a folder that does not exist yet is made, and the file goes in it', async () => {
    const packed = await pack('out/share');
    expect(packed.file_path).toBe(path.join(work, 'out', 'share', 'dinner-vote-1.2.0.guguext'));
    expect(existsSync(packed.file_path)).toBe(true);
  });

  it('a path ending in .guguext is the file itself, its folders made', async () => {
    const packed = await pack(path.join(work, 'deep', 'er', 'vote.guguext'));
    expect(packed.file_path).toBe(path.join(work, 'deep', 'er', 'vote.guguext'));
    expect(packed.file_name).toBe('dinner-vote-1.2.0.guguext');
    expect(readFileSync(packed.file_path, 'utf8')).toBe('guguext-bytes');
  });
});
