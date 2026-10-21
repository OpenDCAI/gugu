import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupLegacyBrowserPartitions,
  migrateLegacyBrowserPartitionDirs,
} from './browser-partition-cleanup';

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent-user-data' } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const created: string[] = [];

/** 一个 `userData/Partitions` 目录,每个分区里放一份 Cookies,用来确认数据跟着目录走。 */
function partitionsDir(partitions: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gugu-partitions-'));
  created.push(dir);
  for (const [name, cookies] of Object.entries(partitions)) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'Cookies'), cookies);
  }
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('migrateLegacyBrowserPartitionDirs', () => {
  it('moves the signed-in profiles and per-task partitions to their new names with their data', () => {
    const dir = partitionsDir({
      'emdash-browser-profile': 'session=default',
      'emdash-browser-profile-work': 'session=work',
      'emdash-browser-isolated-Project-Task': 'session=task',
    });

    migrateLegacyBrowserPartitionDirs(dir);

    expect(readdirSync(dir).sort()).toEqual([
      'gugu-browser-isolated-Project-Task',
      'gugu-browser-profile',
      'gugu-browser-profile-work',
    ]);
    expect(readFileSync(join(dir, 'gugu-browser-profile', 'Cookies'), 'utf8')).toBe('session=default');
  });

  it('leaves both directories alone when the new name already exists', () => {
    const dir = partitionsDir({
      'emdash-browser-profile': 'session=old',
      'gugu-browser-profile': 'session=new',
    });

    migrateLegacyBrowserPartitionDirs(dir);

    expect(readFileSync(join(dir, 'emdash-browser-profile', 'Cookies'), 'utf8')).toBe('session=old');
    expect(readFileSync(join(dir, 'gugu-browser-profile', 'Cookies'), 'utf8')).toBe('session=new');
  });

  it('does not move per-tab partitions or anything that is not a browser partition', () => {
    const dir = partitionsDir({ 'emdash-browser-tab-1': 'x', 'gugu-extension-paper-desk': 'y' });

    migrateLegacyBrowserPartitionDirs(dir);

    expect(readdirSync(dir).sort()).toEqual(['emdash-browser-tab-1', 'gugu-extension-paper-desk']);
  });

  it('does nothing when there is no Partitions directory yet', () => {
    expect(() => migrateLegacyBrowserPartitionDirs(join(tmpdir(), 'gugu-no-partitions-here'))).not.toThrow();
  });
});

describe('cleanupLegacyBrowserPartitions', () => {
  it('removes per-tab partitions under either prefix and keeps profiles, per-task partitions and extensions', async () => {
    const dir = partitionsDir({
      'emdash-browser-tab-1': 'x',
      'gugu-browser-tab-2': 'x',
      'emdash-browser-profile': 'kept because its new twin already existed',
      'gugu-browser-profile': 'keep',
      'gugu-browser-isolated-Project-Task': 'keep',
      'gugu-extension-paper-desk': 'keep',
    });

    await cleanupLegacyBrowserPartitions(dir);

    expect(readdirSync(dir).sort()).toEqual([
      'emdash-browser-profile',
      'gugu-browser-isolated-Project-Task',
      'gugu-browser-profile',
      'gugu-extension-paper-desk',
    ]);
  });
});
