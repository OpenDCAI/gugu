import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export type NodeVersionRequirement = { major: number; minor: number };

/**
 * claude 的 ACP adapter(`@agentclientprotocol/claude-agent-acp`)源码用了 import attributes
 * (`with { type: 'json' }`)—— Node 20.10 才认。拿更老的 node 起它，进程一起来就 SyntaxError 退出，
 * 而调用方只看得见「ACP connection closed」，离真因两级远。所以要求写在这里、由要它的人报出来。
 */
export const NODE_WITH_IMPORT_ATTRIBUTES: NodeVersionRequirement = { major: 20, minor: 10 };

/**
 * claude 的 ACP 桥接自己在 `package.json` 的 `engines` 里声明 `node >=22`(0.75.1 起就是)。
 * 咕咕只按 import attributes 查到 20.10,等于替它放宽了一档 —— 按它自己的声明来(#6394)。
 * `acp.test.ts` 读解析到的那份桥接的 `engines.node` 核对这个值,换版时声明变了就红。
 */
export const NODE_FOR_CLAUDE_ACP: NodeVersionRequirement = { major: 22, minor: 0 };

export type NodeInterpreterSource = 'GUGU_NODE_BIN' | 'PATH' | 'electron';

export type ResolvedNodeInterpreter = {
  command: string;
  /** `v24.14.0`；无版本要求时为 `null`(不为此多花一次 spawn)。 */
  version: string | null;
  source: NodeInterpreterSource;
};

export type Candidate = { command: string; source: NodeInterpreterSource };

/**
 * 候选顺序 = 显式覆盖 → PATH 上的 node → Electron 自带的 node。
 * `GUGU_NODE_BIN` 是**配置**(用户/宿主显式指定跑 JS 的解释器)，不是进程间的意外管道：
 * 谁需要解释器谁在自己的进程里现解析，❌ 靠别处、别的时刻往 process.env 上塞一个全局。
 */
export function nodeCandidates(env: NodeJS.ProcessEnv): Candidate[] {
  const found: Candidate[] = [];
  const override = env.GUGU_NODE_BIN?.trim();
  if (override) {
    // 显式配置指错了当场说。❌ 悄悄跳过再回落到别的解释器：用户以为自己钉住了解释器，
    // 实际跑的是另一个，而且永远不会知道 —— 无版本要求的那条路本来就不探测，接不住这个错。
    if (!existsSync(override)) {
      throw new Error(`GUGU_NODE_BIN 指向的路径不存在：${override}`);
    }
    found.push({ command: override, source: 'GUGU_NODE_BIN' });
  }

  const binName = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, binName);
    if (existsSync(candidate)) found.push({ command: candidate, source: 'PATH' });
  }

  // Electron 自带的 node（配 ELECTRON_RUN_AS_NODE=1）——系统上没装 node 的机器靠它兜底。
  found.push({ command: process.execPath, source: 'electron' });
  return found;
}

const VERSION = /^v(\d+)\.(\d+)\.\d+/;

/** 只认真实回报的版本：探测失败(不是 node / 起不来)一律当"用不了"，❌ 猜。 */
function probeVersion(command: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const out = execFileSync(command, ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      // 真 node 忽略这个变量；Electron 靠它才肯当 node 用。
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    }).trim();
    return VERSION.test(out) ? out : null;
  } catch {
    return null;
  }
}

export function satisfies(version: string, required: NodeVersionRequirement): boolean {
  const parsed = VERSION.exec(version);
  if (!parsed) return false;
  const major = Number(parsed[1]);
  const minor = Number(parsed[2]);
  if (major !== required.major) return major > required.major;
  return minor >= required.minor;
}

const cache = new Map<string, ResolvedNodeInterpreter>();

export type ResolveNodeInterpreterOptions = {
  env?: NodeJS.ProcessEnv;
  /** 最低版本；`null` = 不挑版本(也就不探测)，与「随便找个能跑 JS 的」同义。 */
  require?: NodeVersionRequirement | null;
  /** 谁要用它 —— 只用于报错文案，让人一眼知道是哪条路起不来。 */
  purpose?: string;
};

/**
 * 解析一个能跑 JS 的解释器。带 `require` 时逐个探测真实版本，第一个够新的胜出；
 * 一个都不够就 **抛错**并把「要什么 / 试过谁 / 各自是什么版本」一次说全 —— ❌ 回落到一个明知起不来的
 * 解释器再让它在别处闷声挂掉。
 */
export function resolveNodeInterpreter(
  options: ResolveNodeInterpreterOptions = {}
): ResolvedNodeInterpreter {
  const env = options.env ?? process.env;
  const required = options.require === undefined ? null : options.require;
  const key = `${required ? `${required.major}.${required.minor}` : 'any'}\u0000${env.GUGU_NODE_BIN ?? ''}\u0000${env.PATH ?? ''}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const resolved = pickNodeInterpreter(nodeCandidates(env), required, (command) =>
    probeVersion(command, env)
  );
  if ('command' in resolved) {
    cache.set(key, resolved);
    return resolved;
  }
  const what = options.purpose ? `${options.purpose} ` : '';
  throw new Error(
    `${what}需要 Node ≥${required?.major}.${required?.minor}，这台机器上一个都没找到。\n`
      + `试过：\n  ${resolved.tried.join('\n  ')}\n`
      + '装一个够新的 node 并让它出现在 PATH 上，或用 GUGU_NODE_BIN 指到它。'
  );
}

/**
 * 纯决策：按候选顺序挑第一个满足版本要求的。`required` 为 null 时不探测，直接取第一个候选
 * （「随便找个能跑 JS 的」）。挑不出来时把每个候选的实际版本一并带回，供调用方组织报错。
 */
export function pickNodeInterpreter(
  candidates: readonly Candidate[],
  required: NodeVersionRequirement | null,
  probe: (command: string) => string | null
): ResolvedNodeInterpreter | { tried: string[] } {
  const tried: string[] = [];
  for (const candidate of candidates) {
    if (!required) return { ...candidate, version: null };
    const version = probe(candidate.command);
    if (version && satisfies(version, required)) return { ...candidate, version };
    tried.push(`${candidate.source}: ${candidate.command} = ${version ?? '起不来/不是 node'}`);
  }
  return { tried };
}

/** 测试用：版本探测有缓存，改了 PATH/覆盖项要先清。 */
export function clearNodeInterpreterCache(): void {
  cache.clear();
}
