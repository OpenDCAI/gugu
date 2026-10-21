import path from 'node:path';
import { tmeetCliRecipe } from './tmeet-cli';
import { feishuCliRecipe } from './feishu-cli';
import type { IntegrationCliTool } from '@gugu/session-plugins/integrations';

/**
 * 官方命令行集成(#7210 第二批)里,每一个工具咕咕要知道的事 —— 怎么装、登录要跑什么、登录时它给人看什么、
 * 怎么问它「还登着吗」、它的 skills 在哪。这里只放数据与纯解析(可单测),跑进程、下载、写盘在别的文件里。
 *
 * 两条硬约束:
 *  · ❌ 跑厂商的 npm 安装脚本。dws 的 postinstall 会把 skills 写进用户的 ~/.claude/skills、~/.codex/skills 等
 *    七十多个目录 —— 改用户自己的 agent 配置(product spec「不改用户电脑上 Claude Code、Codex
 *    等自己的配置」)。所以只下载发布包、校验、解出程序体与 skills,装进咕咕自己的目录。
 *  · 工具的登录态放在咕咕给它的目录里(`home`),与用户自己装的同一个工具互不相干;断开 = 删掉这个目录。
 */

export type CliLoginPrompt =
  /** 打开链接、在对方那边确认(设备流)。`code` 是页面上要核对的那串授权码。 */
  | { kind: 'device-link'; url: string; code: string }
  /** 用手机 App 扫码。`image` 是 data URL;`url` 是二维码同一个去处(扫不了时直接打开)。 */
  | { kind: 'qr-code'; image: string; url?: string };

export type CliPlatform = 'darwin-arm64' | 'darwin-x64' | 'linux-arm64' | 'linux-x64';

export function currentCliPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): CliPlatform {
  const key = `${platform}-${arch}`;
  if (key === 'darwin-arm64' || key === 'darwin-x64' || key === 'linux-arm64' || key === 'linux-x64') return key;
  // Windows:dws 的登录态在 Windows 上存进注册表(DPAPI),咕咕给不了它一个独立目录;先不支持,响亮地说。
  throw new Error(`Official CLI integrations are not available on ${platform} ${arch} yet.`);
}

/**
 * 一个工具的发布物在 npm 上的哪个包、哪个版本,以及它的 sha512 integrity —— 都钉在代码里:
 * 装的是哪一份说得出来,下载来的那一份也只拿这里的摘要去核(❌ 信镜像回的元数据里那一个,
 * 镜像被换了包也会给一个对得上的摘要)。摘要取自 registry.npmjs.org,与 npmmirror 核过一致(2026-10-15)。
 */
export type CliPackage = { name: string; version: string; integrity: string };

export type CliToolRecipe = {
  tool: IntegrationCliTool;
  /** 会话里 agent 敲的命令名,也是启动器的文件名。 */
  bin: string;
  version: string;
  /** 带着这台机器程序体的那个 npm 包。 */
  binaryPackage(platform: CliPlatform): CliPackage;
  /** 跑这个工具时要加的环境变量:把它的登录态与缓存关进 `home`。 */
  env(home: string): Record<string, string>;
  loginArgs(work: string): string[];
  /** 登录多久没完成就算超时(对方的授权码 / 二维码本身也会过期)。 */
  loginTimeoutMs: number;
  statusArgs: string[];
  /** 已登录 → true;未登录 → false;读不懂 → 抛错(❌ 当成未登录)。 */
  parseStatus(stdout: string): boolean;
};

const DWS_VERSION = '1.0.64';
const WECOM_VERSION = '1.3.4';
const WECOM_INTEGRITY: Record<CliPlatform, string> = {
  'darwin-arm64': 'sha512-mktTGWYWqwE5exPs/vdiYcwas77G7DPEhAmj1Hl0LqQHUp6tfwplSfJQ/TaESZvmKtoqDglrywtIQeJ0ksFsWA==',
  'darwin-x64': 'sha512-w9TuS95c06uyqbylxNjBCtC3GvR/6Vf6WK1zvsIcif7ivUq6Gu5scssagbD6rBWwhQUJ6o2MQKufpa439mL8bg==',
  'linux-arm64': 'sha512-BUvkJCMiM6aImK1MGjA6TuNslfay9eg/cOrmmvg3RLAlB9xTQUfqdq9YQxFog04wEpnlZSsgNXq6bWQaIvwX9w==',
  'linux-x64': 'sha512-Mguwa8AqwTM5hqKZXBs7lwMJ7AZLCJpu+usuHdQLQV9bzF3gM9e70khKHAQCS7focgMHvT/+mW++S7JvXKdL6Q==',
};
/**
 * wecom-cli 的 skills 只在源码仓里(npm 包不带),钉到一个提交:内容由提交号定死(git 按内容寻址)。
 * 没有摘要可核 —— GitHub 不保证源码归档逐字节稳定,钉归档的 sha256 会在它重新打包时误报。
 */
export const WECOM_SKILLS_COMMIT = '4c74ff28838d8fba267eaab5179d9d56f9ca61ae';

const dws: CliToolRecipe = {
  tool: 'dws',
  bin: 'dws',
  version: DWS_VERSION,
  // dws 的 npm 主包里就带着各平台的归档与 skills 包(assets/),不另分平台包。
  binaryPackage: () => ({
    name: 'dingtalk-workspace-cli',
    version: DWS_VERSION,
    integrity: 'sha512-0ySv3ZezEeMwYY4m3Db7AEON9DceVr/dQaS2lz07gy/fIlNMh50qbnQN7Llqc5B5CjuZoUrBKUaspTbJN0Vyaw==',
  }),
  // 关掉系统钥匙串:登录态落在 `home` 下的加密文件里,咕咕删得掉、也搬得走(dws README「Migrate auth」)。
  env: (home) => ({ HOME: home, DWS_DISABLE_KEYCHAIN: '1' }),
  // 设备流:本机、远程 server、云电脑一样走 —— 回调不必落在某台机器的 127.0.0.1。
  loginArgs: () => ['auth', 'login', '--device'],
  loginTimeoutMs: 15 * 60_000,
  statusArgs: ['auth', 'status', '--format', 'json'],
  parseStatus(stdout) {
    const parsed: unknown = JSON.parse(stdout);
    const authenticated = (parsed as { authenticated?: unknown } | null)?.authenticated;
    if (typeof authenticated !== 'boolean') throw new Error('dws auth status did not say whether it is logged in.');
    return authenticated;
  },
};

const wecom: CliToolRecipe = {
  tool: 'wecom-cli',
  bin: 'wecom-cli',
  version: WECOM_VERSION,
  binaryPackage: (platform) => ({
    name: `@wecom/cli-${platform}`,
    version: WECOM_VERSION,
    integrity: WECOM_INTEGRITY[platform],
  }),
  env: (home) => ({ WECOM_CLI_CONFIG_DIR: path.join(home, 'config') }),
  loginArgs: (work) => ['auth', 'init', '--noninteractive', '--no-browser', '--output-qrcode', wecomQrPath(work)],
  // wecom-cli 自己的扫码等待是 5 分钟。
  loginTimeoutMs: 5 * 60_000 + 15_000,
  statusArgs: ['auth', 'show', '--status'],
  parseStatus(stdout) {
    const value = stdout.trim();
    if (value === 'authorized') return true;
    if (value === 'unauthorized') return false;
    throw new Error(`wecom-cli auth show said "${value}".`);
  },
};

export function wecomQrPath(work: string): string {
  return path.join(work, 'login-qrcode.png');
}

const RECIPES: Record<IntegrationCliTool, CliToolRecipe> = { dws, 'wecom-cli': wecom, 'lark-cli': feishuCliRecipe, tmeet: tmeetCliRecipe };

export function cliToolRecipe(tool: IntegrationCliTool): CliToolRecipe {
  return RECIPES[tool];
}

/**
 * dws 设备流打出来的那一段里,找出「带授权码的链接」。认链接里的 `user_code=`,不认前面那行英文标签 ——
 * 标签随语言变,链接不变。还没打出来 → null(接着等)。
 */
export function parseDwsDevicePrompt(output: string): CliLoginPrompt | null {
  const url = output.match(/https:\/\/\S*[?&]user_code=([A-Za-z0-9-]+)\S*/);
  if (!url?.[1]) return null;
  return { kind: 'device-link', url: url[0], code: url[1] };
}

/** wecom-cli 扫码时打出来的那个链接(与二维码同一个去处)。 */
export function parseWecomQrUrl(output: string): string | undefined {
  return output.match(/https:\/\/work\.weixin\.qq\.com\/\S+/)?.[0];
}
