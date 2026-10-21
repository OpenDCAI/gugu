import path from 'node:path';
import type { CliLoginPrompt, CliToolRecipe } from './cli-tools';

export const TMEET_SKILLS_COMMIT = 'e631b355da2b001d24b82f453b65d96f39c59865';
export const TMEET_BINARY = {
  'darwin-arm64': 'tmeet-macOS-AppleSilicon', 'darwin-x64': 'tmeet-macOS-Intel',
  'linux-arm64': 'tmeet-Linux-ARM64', 'linux-x64': 'tmeet-Linux-x86_64',
} as const;

/** 官方 v1.0.18：配置、密文均明确支持自定义目录，不能碰用户另装那份 tmeet。 */
export const tmeetCliRecipe: CliToolRecipe = {
  tool: 'tmeet', bin: 'tmeet', version: '1.0.18',
  binaryPackage: () => ({ name: '@tencentcloud/tmeet', version: '1.0.18',
    integrity: 'sha512-YFePEDfYhJp95mwOv8GEQ0Q5rqm2tdqHuuCKlgULI7kQicU59a2KkAYnQQgRWhHsxyxTsuWYfeQYG6qZJ6pObw==' }),
  env: (home) => ({ HOME: home, TMEET_CLI_CONFIG_DIR: path.join(home, 'config'), TMEET_CLI_DATA_DIR: path.join(home, 'data') }),
  loginArgs: () => ['auth', 'login', '--no-browser'],
  loginTimeoutMs: 5 * 60_000 + 15_000,
  statusArgs: ['auth', 'status'],
  parseStatus(stdout) {
    if (/Not logged in|Session has expired/i.test(stdout)) return false;
    // status 在网络失败时仍会打印本地的 Logged in。UserName 这一行只在服务端返回用户资料后出现。
    if (/^Logged in\s*$/m.test(stdout) && /^\s*UserName:\s*\S/m.test(stdout) && /RefreshToken:\s*valid/i.test(stdout)) return true;
    throw new Error('Tencent Meeting could not verify the connected account. Please retry.');
  },
};

export function parseTmeetPrompt(output: string): CliLoginPrompt | null {
  const match = output.match(/authorize url:\s*(https:\/\/[^\s\u001b]+)/i);
  if (!match) return null;
  const url = new URL(match[1]);
  if (url.hostname !== 'meeting.tencent.com' && !url.hostname.endsWith('.meeting.tencent.com')) throw new Error('Unexpected Tencent Meeting authorization host');
  return { kind: 'device-link', url: url.href, code: '' };
}
