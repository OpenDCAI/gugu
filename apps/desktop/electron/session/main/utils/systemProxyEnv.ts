/**
 * 系统代理 → agent 与它的安装器(#6892)。
 *
 * 只开系统代理、不开 TUN 的用户(Clash / Surge 的「系统代理」模式,Windows 的「Internet 选项」)很多。
 * Go 写的 agy、Node 写的 harness 只认 `HTTP(S)_PROXY` 这类环境变量,不读系统代理(2026-10-02 mac1:
 * agy 直连 Google 的 443);Linux 上 mise 也是(thinkpad:安装卡在 download)。
 *
 * **一个来源**:Electron 自己的 `session.resolveProxy`(三个平台同一个接口,PAC 也算进去)。❌ 自己去读
 * scutil / 注册表 / gsettings。宿主启动时问一次(`resolveSystemProxy`),记在这里。
 *
 * **只给要它的两类子进程**:`buildAgentEnv`(面板腿、终端腿、模型探针,以及 mise 安装 —— 它取的就是这一份)
 * 与 agent-config worker 的启动环境(harness 的登录态 / 模型目录探针在那个进程里起 agy、codex 这些)。
 * ❌ 写进主进程 `process.env`:用户自己开的终端、主进程里读代理变量的库
 * (issue 集成带进来的 axios)都会跟着变 —— 它们本来认的是系统代理连同它的绕过名单,环境变量表达不了后者。
 *
 * **只补不改**:要起的那份环境里(含用户登录 shell 与 agent 设置里填的)已经有任何一个代理变量,一格都不动。
 */

const PROXY_VARS = new Set(['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY']);

/**
 * 环境变量只能表达「一个」代理,而 PAC 可以按目标分。取一个这两类子进程真会去的外网地址问一次
 * (mise 下载、harness 连厂商都是这类 https 目标)。
 */
const PROBE_URL = 'https://dl.google.com/';

/** 本机回环永远直连:咕咕的 MCP、hook 都在 127.0.0.1 上,走了代理就断。 */
const LOOPBACK_NO_PROXY = 'localhost,127.0.0.1,::1';

export type SystemProxyReading =
  | { proxy: string }
  | { proxy: null; reason: 'direct' | 'unsupported'; detail: string };

let reading: SystemProxyReading | null = null;

/**
 * `resolveProxy` 的回答 → 代理 URL。格式是 PAC 的那一串:`PROXY h:p; DIRECT`、`HTTPS h:p`、`SOCKS5 h:p`、
 * `DIRECT`。只看第一项(Chromium 也是按顺序试)。SOCKS 不翻:`HTTP(S)_PROXY` 填 socks:// 很多客户端不认,
 * 如实报 unsupported,❌ 猜一个。
 */
export function proxyFromPac(answer: string): SystemProxyReading {
  const first = answer.split(';')[0]?.trim() ?? '';
  const [scheme = '', hostPort] = first.split(/\s+/);
  const kind = scheme.toUpperCase();
  if (!kind || kind === 'DIRECT') return { proxy: null, reason: 'direct', detail: first };
  if (hostPort && kind === 'PROXY') return { proxy: `http://${hostPort}` };
  if (hostPort && kind === 'HTTPS') return { proxy: `https://${hostPort}` };
  return { proxy: null, reason: 'unsupported', detail: first };
}

/** 宿主启动时调一次,在起任何 agent / worker 之前。无头宿主的 shim 答 DIRECT(它的代理只能是环境变量)。 */
export async function resolveSystemProxy(
  resolveProxy: (url: string) => Promise<string>
): Promise<SystemProxyReading> {
  reading = proxyFromPac(await resolveProxy(PROBE_URL));
  return reading;
}

function hasProxyVar(env: Record<string, string | undefined> | null | undefined): boolean {
  return Object.entries(env ?? {}).some(([key, value]) => PROXY_VARS.has(key.toUpperCase()) && Boolean(value?.trim()));
}

/**
 * 要补进这份环境的那几格;不该补时是空对象。`alsoConfigured` 是这份环境之外、用户也可能配过代理的地方
 * (worker 继承的是主进程环境,而用户写在 ~/.zshrc 里的代理只在登录 shell 快照里)。
 */
export function systemProxyFill(
  env: Record<string, string | undefined>,
  alsoConfigured?: Record<string, string> | null
): Record<string, string> {
  if (!reading?.proxy || hasProxyVar(env) || hasProxyVar(alsoConfigured)) return {};
  return {
    HTTPS_PROXY: reading.proxy,
    HTTP_PROXY: reading.proxy,
    ...(env.NO_PROXY?.trim() || env.no_proxy?.trim() ? {} : { NO_PROXY: LOOPBACK_NO_PROXY }),
  };
}
