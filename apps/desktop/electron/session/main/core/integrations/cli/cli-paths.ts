import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveGuguHome } from '@gugu/core';
import { pathWithFirst } from '../../pty/server-browser-env';

/** 官方命令行集成的根目录:各工具的程序、skills、登录态,和给 agent 用的启动器。 */
export function cliToolsRoot(guguHome: string = resolveGuguHome()): string {
  return path.join(guguHome, 'integration-tools');
}

/** 已连接的工具的启动器所在目录:它排在 agent 的 PATH 最前,agent 敲 `dws` 用的就是在咕咕里连上的那一个。 */
export function cliLauncherDir(guguHome?: string): string {
  return path.join(cliToolsRoot(guguHome), 'bin');
}

/** 起 agent 时叠上去的 PATH;一个都没连过(目录不在)= 空。 */
export function cliIntegrationPathEnv(
  basePath: string | undefined,
  delimiter: string = path.delimiter,
  guguHome?: string
): Record<string, string> {
  const dir = cliLauncherDir(guguHome);
  return existsSync(dir) ? { PATH: pathWithFirst(dir, basePath, delimiter) } : {};
}
