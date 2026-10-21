import { existsSync, readdirSync, renameSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { log } from '@main/lib/logger';
import { BROWSER_PARTITION_PREFIX, LEGACY_BROWSER_PARTITION_PREFIX } from '@shared/browser';

const PERSIST_PREFIX = 'persist:';
const CURRENT_DIR_PREFIX = BROWSER_PARTITION_PREFIX.slice(PERSIST_PREFIX.length);
const LEGACY_DIR_PREFIX = LEGACY_BROWSER_PARTITION_PREFIX.slice(PERSIST_PREFIX.length);

function defaultPartitionsDir(): string {
  return join(app.getPath('userData'), 'Partitions');
}

function isKeptPartition(name: string, dirPrefix: string): boolean {
  return name.startsWith(`${dirPrefix}-profile`) || name.startsWith(`${dirPrefix}-isolated-`);
}

/**
 * 内置浏览器的分区改过名(`persist:emdash-browser…` → `persist:gugu-browser…`)。一个分区的 cookie、登录态、
 * 本地存储都在 `userData/Partitions/<分区名去掉 persist:>` 这个目录里 —— 只改名字不搬目录,用户在内置浏览器
 * 里登过的站点就会全部掉线,而且界面上不会有任何提示。
 *
 * 所以要在打开任何浏览器会话**之前**(开机时、注册 RPC 之前)同步把目录挪过去:
 * - 只挪具名配置(`-profile…`)和按任务隔离(`-isolated-…`)的目录;按标签页的旧目录本来就该清,交给下面的清理
 * - 新名字的目录已经存在就两边都不动 —— 两份都有数据时不替用户挑
 */
export function migrateLegacyBrowserPartitionDirs(partitionsDir: string = defaultPartitionsDir()): void {
  let names: string[];
  try {
    names = readdirSync(partitionsDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!isKeptPartition(name, LEGACY_DIR_PREFIX)) continue;
    const target = `${CURRENT_DIR_PREFIX}${name.slice(LEGACY_DIR_PREFIX.length)}`;
    if (existsSync(join(partitionsDir, target))) {
      log.warn('Browser partition: legacy and current directories both exist; leaving both', {
        legacy: name,
        current: target,
      });
      continue;
    }
    try {
      renameSync(join(partitionsDir, name), join(partitionsDir, target));
      log.info('Browser partition: moved legacy directory to its new name', { from: name, to: target });
    } catch (error) {
      log.warn('Browser partition: failed to move legacy directory', {
        from: name,
        to: target,
        error: String(error),
      });
    }
  }
}

/**
 * Browsers used to get one persistent partition per browser tab. Keep named
 * profile and isolated-task partitions, but remove old unused tab partitions so
 * stale cookies and caches do not accumulate in userData/Partitions.
 * 改名前后的两种前缀都认:改名前留下的按标签页分区同样该清。
 */
export async function cleanupLegacyBrowserPartitions(
  partitionsDir: string = defaultPartitionsDir()
): Promise<void> {
  let entries;
  try {
    entries = await readdir(partitionsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPrefix = [CURRENT_DIR_PREFIX, LEGACY_DIR_PREFIX].find((prefix) =>
      entry.name.startsWith(`${prefix}-`)
    );
    if (!dirPrefix || isKeptPartition(entry.name, dirPrefix)) continue;
    try {
      await rm(join(partitionsDir, entry.name), { recursive: true, force: true });
    } catch (error) {
      log.warn('Failed to remove legacy browser partition', { partition: entry.name, error });
    }
  }
}
