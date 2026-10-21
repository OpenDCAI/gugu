import { homedir } from 'node:os';
import { join } from 'node:path';

export const CURRENT_DB_FILENAME = 'gugu4.db';
/**
 * 改名前的库文件名。**同一个 schema、同一份数据**,只是换了名字,所以开机时是
 * 「改名」而不是「拷一份」—— 见 database-file.ts。
 */
export const RENAMED_FROM_DB_FILENAME = 'emdash4.db';
const USER_DATA_DIR_NAME = 'gugu';

/**
 * Returns the platform-specific default userData directory without requiring
 * the Electron `app` module.
 *
 * ⚠️ 这不是产品跑起来时用的目录 —— 打包后的咕咕用 Electron 按 productName(「咕咕」)
 * 算出来的那个。这里只服务于 drizzle-kit 这类**没有 Electron 运行时**的命令行工具。
 *
 * Pass this result as `userDataPath` to `resolveDatabasePath()` when running
 * outside of Electron (e.g. drizzle-kit CLI).
 */
export function resolveDefaultUserDataPath(): string {
  const home = process.env.HOME ?? homedir();
  const platform = process.platform;

  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', USER_DATA_DIR_NAME);
  }

  if (platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    return join(appData, USER_DATA_DIR_NAME);
  }

  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(home, '.config');
  return join(xdgConfig, USER_DATA_DIR_NAME);
}

/**
 * Returns the default database file path given a resolved userData directory.
 * Does not check for file existence or perform any migration — suitable for
 * contexts that only need a path (e.g. drizzle-kit config).
 */
export function defaultDbFilePath(userDataPath: string): string {
  return join(userDataPath, CURRENT_DB_FILENAME);
}
