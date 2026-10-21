import path from 'node:path';
import type { CliPlatform, CliToolRecipe } from './cli-tools';

export const FEISHU_CLI_VERSION = '1.0.98';
export const FEISHU_SKILLS_COMMIT = 'ac81f5056ab88f37d581d25916f3dab85abfca76';
// 官方 v1.0.98 release 的 checksums.txt；下载后只信这些固定摘要。
export const FEISHU_BINARY_SHA256: Record<CliPlatform, string> = {
  'darwin-arm64': 'ee4a3209bbf8b74ea5c00a07d0da89b79f5e7f6abfd518a8b2d78a7a4f7e3f40',
  'darwin-x64': '44a4ff98e969385fc4bb4d701735ba319307e50560fa6c4c956178d70ccc3525',
  'linux-arm64': 'f798b26ce4b369d70411945e7f66bbe4382c411bc47d81950a662de7b69b41ed',
  'linux-x64': '4a12dcb7a0aab25986d8bcd046cb45b08278531a9aac3a12b53cf3d94738fe80',
};

export function feishuArchiveName(platform: CliPlatform): string {
  return `lark-cli-${FEISHU_CLI_VERSION}-${platform.replace('-x64', '-amd64')}.tar.gz`;
}

export function parseFeishuStatus(stdout: string): boolean {
  const value = JSON.parse(stdout) as {
    identity?: unknown;
    identities?: { user?: { available?: unknown; status?: unknown; verified?: unknown; message?: string } };
  };
  const user = value.identities?.user;
  if (!user || typeof user.available !== 'boolean' || typeof user.status !== 'string') {
    throw new Error('lark-cli auth status did not report the user identity.');
  }
  if (user.status === 'error') throw new Error(user.message || 'lark-cli could not inspect the user identity.');
  // 机器人可用并不表示用户已授权；失效与缺失都不算已连接。
  if (['not_configured', 'missing', 'verify_failed'].includes(user.status)) return false;
  if (!['ready', 'needs_refresh'].includes(user.status)) throw new Error(`Unknown lark-cli user status: ${user.status}`);
  return value.identity === 'user' && user.available && user.verified !== false;
}

export const feishuCliRecipe: CliToolRecipe = {
  tool: 'lark-cli',
  bin: 'lark-cli',
  version: FEISHU_CLI_VERSION,
  binaryPackage: () => ({
    name: '@larksuite/cli', version: FEISHU_CLI_VERSION,
    integrity: 'sha512-1AzjdhZ3VXRWnaftb7Mx/SWA3zvs7Mk5W5R1OfThKruQa1ABO8dFZB3V20ZngJigDYiqoUvL/bNqlKZOYLaZbg==',
  }),
  env: (home) => ({
    HOME: home,
    LARKSUITE_CLI_CONFIG_DIR: path.join(home, 'config'),
    LARKSUITE_CLI_DATA_DIR: path.join(home, 'data'),
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
  }),
  loginArgs: () => ['auth', 'login', '--recommend', '--json'],
  loginTimeoutMs: 15 * 60_000,
  statusArgs: ['auth', 'status', '--json'],
  parseStatus: parseFeishuStatus,
};
