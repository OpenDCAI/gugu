import fs from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { log } from '@main/lib/logger';
import {
  CURRENT_DB_FILENAME,
  RENAMED_FROM_DB_FILENAME,
} from './default-path';

/**
 * 把改名前的库(`emdash4.db`)原地改名成现在的名字。
 *
 * 是**改名**不是拷贝:两者 schema 与加密密钥完全相同,只是文件名换了。
 *
 * 改名前先把 WAL 收进主库:收完 SQLite 会在关闭最后一个连接时删掉 `-wal`/`-shm`,
 * 主库文件自己就是完整的,单独改名不会丢最近的写入。
 */
function renameLegacyDatabase(legacyPath: string, currentPath: string): boolean {
  try {
    const legacy = new Database(legacyPath);
    try {
      legacy.pragma('busy_timeout = 5000');
      legacy.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      legacy.close();
    }
    fs.renameSync(legacyPath, currentPath);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(`${legacyPath}${suffix}`)) {
        fs.renameSync(`${legacyPath}${suffix}`, `${currentPath}${suffix}`);
      }
    }
    return true;
  } catch (error) {
    // 改不动就继续用旧名字那份 —— 宁可名字是旧的,也不能让人打开一个空应用。
    // 但**必须留声**:最常见的原因是同机另一个实例正开着这个库,那一刻界面一切正常、
    // 只有文件名停在旧的,不写这一行就没有任何地方说得清为什么。
    log.warn('database rename to the current filename failed; staying on the previous name', {
      from: legacyPath,
      to: currentPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export function resolveDefaultDatabasePath(userDataPath: string): string {
  fs.mkdirSync(userDataPath, { recursive: true });

  const currentPath = join(userDataPath, CURRENT_DB_FILENAME);
  if (fs.existsSync(currentPath)) {
    return currentPath;
  }

  const renamedFromPath = join(userDataPath, RENAMED_FROM_DB_FILENAME);
  if (fs.existsSync(renamedFromPath)) {
    return renameLegacyDatabase(renamedFromPath, currentPath) ? currentPath : renamedFromPath;
  }

  return currentPath;
}
