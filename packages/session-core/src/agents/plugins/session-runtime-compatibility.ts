import semver from 'semver';
import { resolveCommandPath, versionLineOf, withProbeSwitches } from '../../host-dependencies/runtime';
import type { IExecutionContext } from '../../exec';
// ⚠️ 直接从无 `node:` 导入的那个模块取,❌ 走 `../../exec` 的 barrel:本文件在 web 构建里(#6390)。
import {
  resolvePosixNodeScriptEntry,
  resolveWindowsNodeScriptEntry,
  type WindowsShimReader,
} from '../../exec/windows-node-entry';
import {
  harnessSelfUpdateLaunch,
  matchesRuntimeCompatibility,
  requiredExactRuntimeCompatibility,
  type HarnessSessionSurface,
  type SessionBundleDescriptor,
  type SessionRuntimeCompatibility,
} from './capabilities/session-bundle';

export type SessionRuntimeCompatibilityErrorCode =
  | 'runtime-surface-undeclared'
  | 'runtime-version-probe-failed'
  | 'runtime-version-probe-cancelled'
  | 'runtime-version-unparseable'
  | 'runtime-version-unsupported'
  | 'runtime-compatibility-missing'
  | 'runtime-entry-unresolved';

/** 探针到底做了什么、得到了什么 —— 版本读不出来时,答案只能从这里来。 */
export interface RuntimeVersionProbeRecord {
  /** 真正被执行的那个可执行文件(绝对路径)。 */
  executable: string;
  /** 传给它的参数,通常是 `--version`。 */
  args: readonly string[];
  /** 它打出来的东西(stdout+stderr,已截断成一行);执行失败时为 null。 */
  output: string | null;
  /** 执行本身失败时的原因;能跑起来就是 null。 */
  failure: string | null;
  /**
   * 执行失败时系统给的错误码(`ENOENT` / `EACCES` …);跑起来了就是 null。
   * 调用方按它分支(#2576:找不到可执行文件 ⇒ 安装指引),❌ 去解析 `failure` 那句话。
   */
  errno: string | null;
  /**
   * 探针跑时的 PATH —— 与将要 spawn 的那一份相同。#3685:GUI 起的 app 拿的是 launchd 的最小 PATH,
   * `#!/usr/bin/env node` 的 shim 因此跑不起来;不把 PATH 摆出来,下一个人无法判断「为什么这台机器不行」。
   */
  pathEnv: string | null;
}

/** 探针记录压成一行,进错误文案。长输出截断 —— 这是给人看的一句话,不是日志。 */
function describeProbe(probe: RuntimeVersionProbeRecord | null): string {
  if (!probe) return '';
  const invocation = `${probe.executable} ${probe.args.join(' ')}`.trim();
  if (probe.failure) {
    // 失败时引擎自己的话最值钱(`env: node: No such file or directory` 只出现在这里),PATH 是它的上下文。
    const said = (probe.output ?? '').trim();
    return ` Probed \`${invocation}\`, which failed: ${probe.failure}.`
      + (said ? ` It printed: "${said}".` : '')
      + (probe.pathEnv !== null ? ` PATH=${probe.pathEnv}.` : '');
  }
  const printed = (probe.output ?? '').replace(/\s+/g, ' ').trim();
  return ` Probed \`${invocation}\`, which printed ${printed ? `"${printed}"` : 'nothing'}.`;
}

/** 单行化 + 截断,避免把整屏输出塞进一条错误消息。 */
export function summarizeProbeOutput(output: string, limit = 200): string {
  const flat = output.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * harness 自己的进程起不来时它自己说的话(原话、stderr、解析器对它的诊断)。起任务失败交给界面时按这个类型认
 * 「这是 harness 说的」,照 #4657 递原话;其余不带原因码的都算咕咕这一侧,只说「咕咕这边出错了」(#7103)。
 */
export class HarnessStartupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HarnessStartupError';
  }
}

export class SessionRuntimeCompatibilityError extends Error {
  readonly type = 'runtime-compatibility' as const;
  readonly code: SessionRuntimeCompatibilityErrorCode;
  readonly providerId: string;
  readonly surface: HarnessSessionSurface;
  readonly installedVersion: string | null;
  readonly supportedFloor: string | null;
  readonly supportedRanges: readonly string[] | null;
  readonly runtime: 'harness' | 'node';
  /**
   * 版本探针的现场。
   *
   * ⚠️ 少了它,`found unknown` 就是一句无法诊断的话:探针**没跑起来**和探针**跑了但没打版本号**
   * 是两种完全不同的故障(一个查 PATH / 权限 / 超时,一个查那家 `--version` 的输出格式),
   * 而旧文案把两者印成同一句。2026-09-09 实撞:opencode 装的是 1.18.28,界面却说
   * 「requires 1.18.0 or newer; found unknown」,没有任何线索指向该查哪一边。
   */
  readonly probe: RuntimeVersionProbeRecord | null;

  constructor(input: {
    code: SessionRuntimeCompatibilityErrorCode;
    providerId: string;
    surface: HarnessSessionSurface;
    installedVersion: string | null;
    supportedFloor?: string | null;
    supportedRanges?: readonly string[] | null;
    runtime?: 'harness' | 'node';
    probe?: RuntimeVersionProbeRecord | null;
    /** 仅 `runtime-entry-unresolved`:那个没能解析出 JS 入口的壳。 */
    executable?: string;
    cause?: unknown;
  }) {
    const installed = input.installedVersion ?? 'unknown';
    const requirement = input.supportedRanges?.length
      ? `one of ${input.supportedRanges.join(', ')}`
      : input.supportedFloor
        ? `${input.supportedFloor} or newer`
        : 'a declared version';
    const runtime = input.runtime === 'node' ? 'Node runtime' : 'harness runtime';
    const message = input.code === 'runtime-version-probe-cancelled'
      ? `${input.providerId} ${input.surface}: start cancelled while checking the engine executable.`
        + `${describeProbe(input.probe ?? null)}`
      : input.code === 'runtime-surface-undeclared'
      ? `${input.providerId} does not declare session surface '${input.surface}'; refusing to execute.`
      : input.code === 'runtime-compatibility-missing'
        ? `${input.providerId} ${input.surface} has no runtime compatibility declaration; refusing to execute.`
      : input.code === 'runtime-entry-unresolved'
        ? `${input.providerId} ${input.surface} runs through Node, but ${input.executable ?? 'the harness executable'}`
          + ' is a Windows shell script whose JavaScript entry could not be read from it; refusing to hand it to node.'
          + ' Reinstall the engine, then retry.'
      : `${input.providerId} ${input.surface} requires ${runtime} ${requirement}; found ${installed}.`
          + `${describeProbe(input.probe ?? null)} Update it, then retry.`;
    super(message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'SessionRuntimeCompatibilityError';
    this.code = input.code;
    this.providerId = input.providerId;
    this.surface = input.surface;
    this.installedVersion = input.installedVersion;
    this.supportedFloor = input.supportedFloor ?? null;
    this.supportedRanges = input.supportedRanges ?? null;
    this.runtime = input.runtime ?? 'harness';
    this.probe = input.probe ?? null;
  }
}

export function assertSessionSurfaceDeclared(input: {
  providerId: string;
  surface: HarnessSessionSurface;
  descriptor: SessionBundleDescriptor;
}): void {
  const declared = input.descriptor.surfaces.includes(input.surface);
  // `app-server` is a host transport surface. Its session-page integration is the
  // session-TUI cell that selects the app-server adapter (for example Codex), so
  // it must use that cell when validating the declared runtime surface.
  const sessionpageIntegration = input.surface === 'acp' || input.surface === 'tui'
    ? input.descriptor.sessionpage[input.surface]
    : input.surface === 'app-server'
      ? input.descriptor.sessionpage['tui']
      : undefined;
  if (declared && !sessionpageIntegration) {
    throw new SessionRuntimeCompatibilityError({
      code: 'runtime-surface-undeclared',
      providerId: input.providerId,
      surface: input.surface,
      installedVersion: null,
    });
  }
  if (
    (declared && Boolean(sessionpageIntegration))
    || (
      input.surface === 'tui'
      && input.descriptor.surfaces.includes('app-server')
      && Boolean(sessionpageIntegration)
    )
  ) return;
  throw new SessionRuntimeCompatibilityError({
    code: 'runtime-surface-undeclared',
    providerId: input.providerId,
    surface: input.surface,
    installedVersion: null,
  });
}

function parseRuntimeVersion(output: string, versionLine?: RegExp): string | null {
  // 尾边界除了行尾/空白,还容**终端性标点**(句号/逗号/分号/右括号,其后必须是行尾或空白):
  // copilot 1.0.82 的 `--version` 逐字打出 "GitHub Copilot CLI 1.0.82."(句号收尾),
  // 2026-09-01 真机实撞 —— 只认 `$|\s` 会把现役版本判成 unparseable,让 floor 闸恒红。
  // 标点后必须终端,是为了不把 "1.0.82.3" 这类四段版本误配成前三段。
  const versionPattern = /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=$|\s|[.,;)](?:$|\s))/gm;
  const versionsIn = (text: string) => [...text.matchAll(versionPattern)].map((match) => match[1]);
  // 这一家自己那一行(`versionLineOf`:包装器的 banner 里也会有版本号);认不出就照旧读法。
  const own = versionLineOf(output, versionLine);
  if (own !== null) {
    const inOwn = versionsIn(own);
    if (inOwn.length === 1) return inOwn[0];
  }
  const matches = versionsIn(output);
  if (matches.length === 1) return matches[0];
  // 整段里不止一个版本号(hermes 0.21.0 的 `--version` 还列 Python 3.11.16、OpenAI SDK 2.24.0):
  // 认第一行 —— 与资源库读版本(host-dependency-manager 的 `extractVersion`)同一个口径;第一行也不唯一就不猜。
  const first = versionsIn(output.trim().split('\n')[0] ?? '');
  return first.length === 1 ? first[0] : null;
}

export type SessionRuntimeResolution = {
  executable: string;
  /** When set, the host must launch the harness through this interpreter. */
  runtimeExecutable?: string;
  /**
   * 探针对**将要 spawn 的那个 harness 可执行文件**读到的版本(命中缓存时是同一键下记住的读数)。
   * 没声明 runtimeCompatibility 的家不探;声明 `runtime: 'node'` 的家探的是 node 不是 harness —— 两种都为 null。
   * hook 按版本声明(HookSpec.sinceVersion)时只认这一个出处。
   */
  harnessVersion: string | null;
};

function runtimeSatisfied(version: string, requirement: SessionRuntimeCompatibility): boolean {
  if (requirement.kind === 'semver-supported-floor') {
    return semver.gte(version, requirement.supportedFloor);
  }
  return requirement.supportedRanges.some((range) => semver.satisfies(version, range));
}

/**
 * 启动提速 —— 版本探针的结果按「执行上下文 × 可执行文件 × 参数」记住,只记**已判定兼容**的版本。
 * 它此前在每条 ACP / PTY 会话启动时都重新 spawn 一回 `node --version`(串在关键路径上,MBP 实测几十到
 * 上百毫秒,机器忙时更久),而同一台宿主上同一个可执行文件一旦兼容,进程存活期间不会变得不兼容。
 * 按执行上下文分格:本地与 SSH 宿主各有各的 `node`,❌ 共用一个答案。
 * 不兼容 / 探不到 / 解析不了都不进缓存 —— 用户就地升级后重试,下一次照旧真探。
 *
 * #5381 ④ 是同一件事的另一面:同一台机器、同一个 opencode 1.18.28,先成功起过一次会话,十几秒后
 * 再起就报「requires 1.18.0 or newer; found unknown」—— 每次都真探,等于把一次环境抖动变成
 * 「这条会话打不开」,报出来的话还在指责用户的版本太旧。
 *
 * **换选择不需要通知它**:键里就有可执行文件,换了一份拷贝就是另一个键,自然查不中(#5605)。
 * 路径没变而二进制换了(就地装新版):本机调用方递 `fileStamp`,键里就带上那份文件的真实路径 + mtime + size,
 * 换过就查不中;咕咕自己装的那条路另由 `install` 调 `clearRuntimeVersionProbeCache()`。
 * ❌ 别改成 TTL:那是在猜用户什么时候升级。
 * 已知边界:版本管理器的 shim(mise / asdf / volta)换到**低于下界**的版本时,shim 文件本身不变 ⇒ stamp 不变,
 * 之前判定兼容的读数一直被放行到重启。没观察到过;撞上了先查这里。(升级方向不受影响:不兼容的读数从不进缓存。)
 */
let compatibleRuntimeVersions = new WeakMap<IExecutionContext, Map<string, string>>();
function cachedCompatibleVersion(context: IExecutionContext, key: string): string | undefined {
  return compatibleRuntimeVersions.get(context)?.get(key);
}
function rememberCompatibleVersion(context: IExecutionContext, key: string, version: string): void {
  const perContext = compatibleRuntimeVersions.get(context) ?? new Map<string, string>();
  perContext.set(key, version);
  compatibleRuntimeVersions.set(context, perContext);
}

/** 装新版 / 改了选择 ⇒ 之前判定兼容的版本全部作废(WeakMap 没有 clear,换一张新的)。 */
export function clearRuntimeVersionProbeCache(): void {
  compatibleRuntimeVersions = new WeakMap();
}

/**
 * 执行失败的系统错误名。进程组那条执行路把 `code` 让给了退出码(spawn 失败时写成 null),
 * 系统错误名放在 `spawnErrorCode`;其它执行路就在 `code` 上。
 */
function systemErrorName(failed: { code?: unknown; spawnErrorCode?: unknown }): string | null {
  if (typeof failed.spawnErrorCode === 'string') return failed.spawnErrorCode;
  return typeof failed.code === 'string' ? failed.code : null;
}

/**
 * 探针实际用的 PATH —— 只报调用方递进来的那一份。没递就是执行上下文自己的环境(本机 / SSH 各不同),
 * 这里看不见它 ⇒ null,❌ 拿本进程的 `process.env` 冒充(那是另一个对象)。
 */
function probeEnvPath(input: { env?: Record<string, string> }): string | null {
  return input.env?.PATH ?? null;
}

/** Probe only a descriptor-declared surface and return the runtime used to launch it. */
export async function resolveSessionRuntimeCompatible(input: {
  providerId: string;
  surface: HarnessSessionSurface;
  descriptor: SessionBundleDescriptor;
  executable: string;
  /** 这一家 `--version` 里它自己的那一行(`HostDependencyDescriptor.versionLine`);只用于探它本身,❌ 用于探 node。 */
  versionLine?: RegExp;
  executionContext: IExecutionContext;
  /**
   * 这一家跑起来时的那份环境(#5702)。会话启动前的这次 `--version` 探的就是将要跑的那份二进制,
   * 环境也必须是将要带的那份 —— 实测(2026-09-16 MBP):这条探测跑的是选中那份,却读不到用户
   * 在 Agents 设置里为这一家填的变量,而那些变量恰恰能左右它跑不跑得起来。
   */
  env?: Record<string, string>;
  /** Explicit interpreter selected by the host (for example GUGU_NODE_BIN). */
  runtimeExecutable?: string;
  /** 本机平台;只为让判据在非 Windows 上也能走 Windows 那一支。缺省 `process.platform`。 */
  platform?: NodeJS.Platform;
  /**
   * 读壳的那一半(#6390)。只有「经 node 起、且真要把路径交给 node」的调用方需要递 ——
   * 本机 Windows 上缺了它,经 node 起的家响亮失败,❌ 把壳交给 node;POSIX 上缺了它,咕咕自己的
   * sh 启动器原样交给 node(那就是 10-07 mac1 上托管 pi 的 SyntaxError)。
   */
  windowsShimReader?: WindowsShimReader;
  /**
   * 读盘的另一半:被探那份文件此刻的身份(真实路径 + mtime + size),并进缓存键(见上面缓存的说明)。
   * 只有本机宿主递(`diskFileStamp`);不递 = 键里只有路径。
   */
  fileStamp?: (file: string) => string | null;
  /**
   * 这次会话启动的寿命。探针只等「`--version` 退出」这一个事实,❌ 不设时钟;
   * 启动被它的属主放弃(停止 / 删除)时,由这个信号收掉仍在跑的探针。
   */
  signal?: AbortSignal;
}): Promise<SessionRuntimeResolution> {
  assertSessionSurfaceDeclared(input);
  const requirement = input.descriptor.runtimeCompatibility?.[input.surface];
  if (Array.isArray(requirement)) {
    let result: SessionRuntimeResolution = { executable: input.executable, harnessVersion: null };
    for (const entry of requirement) {
      const resolved = await resolveSessionRuntimeCompatible({
        ...input,
        descriptor: { ...input.descriptor, runtimeCompatibility: { ...input.descriptor.runtimeCompatibility, [input.surface]: entry } },
      });
      result = { ...(entry.runtime === 'node' ? resolved : result), harnessVersion: resolved.harnessVersion ?? result.harnessVersion };
    }
    return result;
  }
  const measuredRequirement = requiredExactRuntimeCompatibility(input.descriptor, input.surface);
  if (!requirement) {
    if (measuredRequirement) {
      throw new SessionRuntimeCompatibilityError({
        code: 'runtime-compatibility-missing',
        providerId: input.providerId,
        surface: input.surface,
        installedVersion: null,
      });
    }
    return { executable: input.executable, harnessVersion: null };
  }
  if (measuredRequirement && !matchesRuntimeCompatibility(requirement, measuredRequirement)) {
    throw new SessionRuntimeCompatibilityError({
      code: 'runtime-version-unsupported', providerId: input.providerId, surface: input.surface,
      installedVersion: requirement.kind === 'semver-supported-floor' ? requirement.supportedFloor : null,
      supportedFloor: measuredRequirement.supportedFloor,
      runtime: requirement.runtime,
    });
  }

  // 经 node 起的家,交给 node 的必须是 JS 入口(#6390):Windows 上托管入口是 `.cmd` 壳,POSIX 上是咕咕自己的
  // sh 启动器,`node <壳>` 都是第一行就 SyntaxError。沿壳读出真入口,读不出就在这里响亮失败。
  // 只在本机执行上下文做:SSH 宿主的平台与文件系统都不是这一边的。
  const platform = input.platform ?? process.platform;
  const readsShim = requirement.runtime === 'node' && input.executionContext.supportsLocalSpawn;
  // POSIX 的启动器还钉着咕咕那份 node(没装 node 的机器上只有它能跑这一家):宿主没指定解释器时就用它。
  const posixLauncher = readsShim && platform !== 'win32' && input.windowsShimReader
    ? resolvePosixNodeScriptEntry(input.executable, input.windowsShimReader)
    : undefined;

  const runtimeExecutable = requirement.runtime === 'node'
    ? input.runtimeExecutable ?? posixLauncher?.node ?? await resolveCommandPath('node', input.executionContext)
    : input.executable;
  if (!runtimeExecutable) {
    throw new SessionRuntimeCompatibilityError({
      code: 'runtime-version-probe-failed', providerId: input.providerId, surface: input.surface,
      installedVersion: null,
      supportedFloor: requirement.kind === 'semver-supported-floor' ? requirement.supportedFloor : null,
      supportedRanges: requirement.kind === 'semver-supported-ranges' ? requirement.supportedRanges : null,
      runtime: requirement.runtime,
      cause: new Error(
        requirement.runtime === 'node'
          ? 'Could not resolve Node. Install a supported Node or set GUGU_NODE_BIN.'
          : 'Could not resolve the declared runtime executable.'
      ),
    });
  }

  const executable = !readsShim
    ? input.executable
    : platform !== 'win32'
      ? posixLauncher === undefined ? input.executable : posixLauncher?.entry ?? null
      : input.windowsShimReader
        ? resolveWindowsNodeScriptEntry(input.executable, { platform, reader: input.windowsShimReader })
        : null;
  if (!executable) {
    throw new SessionRuntimeCompatibilityError({
      code: 'runtime-entry-unresolved', providerId: input.providerId, surface: input.surface,
      installedVersion: null,
      runtime: requirement.runtime,
      executable: input.executable,
    });
  }

  const probeExecutable = requirement.runtime === 'node' ? runtimeExecutable : input.executable;
  const stamp = input.fileStamp?.(probeExecutable) ?? null;
  const probeKey = `${runtimeExecutable} ${requirement.versionArgs.join(' ')}${stamp ? ` @${stamp}` : ''}`;
  const cachedVersion = cachedCompatibleVersion(input.executionContext, probeKey);
  if (cachedVersion) {
    return {
      executable,
      ...(requirement.runtime === 'node' ? { runtimeExecutable } : {}),
      harnessVersion: requirement.runtime === 'node' ? null : cachedVersion,
    };
  }

  // 探的就是将要跑的那一份 —— **未包壳的**可执行文件本体。
  //
  // ⚠️ ❌ 不收调用方递进来的「已经包好壳的 argv」(此前的 `versionProbe`)。Windows 上把
  // `.cmd` 壳包成 `cmd.exe /d /s /c "<转义过的命令行>"` 之后,那条命令行**只有**配上
  // `windowsVerbatimArguments: true` 才成立;而这个边界的形状是 `{executable, args}`,
  // 它**装不下那个开关** —— 于是 execFile 又把整条命令行引一次,cmd.exe 收到的是
  // `'\"C:\…\codex.cmd ^^^\"--version^\"\"' is not recognized…`,探针当场失败。
  // 用户看到的是「requires harness runtime X or newer; found unknown」:一句指着版本、
  // 与真因隔着三层的话(2026-09-18 Windows 真机实撞,codex 的 Code/TUI 会话因此一条都开不起来)。
  // ⇒ 包壳这件事**只有一个属主**:执行上下文自己的 `planDirectSpawn`(见 exec/windows-launcher.ts),
  // 它同时产出 argv 与那组必须一起带上的 spawn 开关。这里递原始路径,让它去包。
  const probeArgs = [...requirement.versionArgs];
  // 这次探测也是一次「跑它」:带上这一家声明的关自更新开关(#6186)。
  const probeEnv = withProbeSwitches(
    input.executionContext,
    input.env,
    harnessSelfUpdateLaunch(input.descriptor).env,
  );
  const probeStartedAt = Date.now();
  // @@@6183 探针等的是**这个进程退出并打印版本号**这一个事实,❌ 不设时钟。
  // 这里曾有 `timeout: 5_000`:mac1 load 31–48 时 shell 里直接跑 `mimo --version` 要 3.6–24s,
  // 那个进程活着、会答,只是慢 —— 5s 的时钟把「慢」判成「这一家不可用」,整家 harness 被挡在门外。
  // 时钟量的是机器此刻的负载,不是这个二进制的任何性质。放弃等待是启动属主的决定,走 `signal`。
  let output: string;
  try {
    const result = await input.executionContext.exec(
      probeExecutable,
      probeArgs,
      {
        maxBuffer: 64 * 1024,
        // 进程组 + stdin 关闭:卡在交互提示上的 `--version` 读到 EOF 退出;被放弃时整棵树一起收掉。
        processGroup: true,
        ...(probeEnv ? { env: probeEnv } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      }
    );
    output = `${result.stdout}\n${result.stderr}`.trim();
  } catch (cause) {
    const failed = cause as { code?: unknown; spawnErrorCode?: unknown; stdout?: unknown; stderr?: unknown };
    const printed = [failed.stderr, failed.stdout]
      .map((part) => (typeof part === 'string' ? part : '')).join('\n');
    // 被启动属主放弃 ≠ 这份二进制有问题:如实说「取消时 `--version` 已经跑了多久还没退出」,
    // ❌ 说成「found unknown, update it」(那会把用户支去升级一个没毛病的东西)。
    const cancelled = input.signal?.aborted === true;
    throw new SessionRuntimeCompatibilityError({
      code: cancelled ? 'runtime-version-probe-cancelled' : 'runtime-version-probe-failed',
      providerId: input.providerId, surface: input.surface,
      installedVersion: null,
      supportedFloor: requirement.kind === 'semver-supported-floor' ? requirement.supportedFloor : null,
      supportedRanges: requirement.kind === 'semver-supported-ranges' ? requirement.supportedRanges : null,
      runtime: requirement.runtime,
      probe: {
        executable: probeExecutable,
        args: probeArgs,
        output: printed.trim() ? summarizeProbeOutput(printed) : null,
        failure: cancelled
          ? `still running after ${((Date.now() - probeStartedAt) / 1000).toFixed(1)}s when the start was cancelled`
          : cause instanceof Error ? cause.message.split('\n')[0] : String(cause),
        errno: systemErrorName(failed),
        pathEnv: probeEnvPath(input),
      },
      cause,
    });
  }

  const probe: RuntimeVersionProbeRecord = {
    executable: probeExecutable,
    args: probeArgs,
    output: summarizeProbeOutput(output),
    failure: null,
    errno: null,
    pathEnv: probeEnvPath(input),
  };

  const installedVersion = parseRuntimeVersion(output, requirement.runtime === 'node' ? undefined : input.versionLine);
  if (!installedVersion) {
    throw new SessionRuntimeCompatibilityError({
      code: 'runtime-version-unparseable', providerId: input.providerId, surface: input.surface,
      installedVersion: null,
      supportedFloor: requirement.kind === 'semver-supported-floor' ? requirement.supportedFloor : null,
      supportedRanges: requirement.kind === 'semver-supported-ranges' ? requirement.supportedRanges : null,
      runtime: requirement.runtime,
      probe,
    });
  }
  if (!runtimeSatisfied(installedVersion, requirement)) {
    throw new SessionRuntimeCompatibilityError({
      code: 'runtime-version-unsupported', providerId: input.providerId, surface: input.surface,
      installedVersion,
      supportedFloor: requirement.kind === 'semver-supported-floor' ? requirement.supportedFloor : null,
      supportedRanges: requirement.kind === 'semver-supported-ranges' ? requirement.supportedRanges : null,
      runtime: requirement.runtime,
      probe,
    });
  }
  // 走到这里 = 版本读出来了、也过了闸。记下来,同一执行上下文里下一条会话不必再 spawn 一次。
  rememberCompatibleVersion(input.executionContext, probeKey, installedVersion);
  return {
    executable,
    ...(requirement.runtime === 'node' ? { runtimeExecutable } : {}),
    harnessVersion: requirement.runtime === 'node' ? null : installedVersion,
  };
}

/** Keep provider command construction pure while applying a declared interpreter at the host edge. */
export function applySessionRuntimeCommand(
  command: import('./capabilities/prompt').AgentCommand,
  input: { harnessExecutable: string; runtimeExecutable?: string },
): import('./capabilities/prompt').AgentCommand {
  if (!input.runtimeExecutable || input.runtimeExecutable === command.command) return command;
  return {
    ...command,
    command: input.runtimeExecutable,
    args: [input.harnessExecutable, ...command.args],
  };
}

/** Backwards-compatible assertion for callers that only need the unchanged harness path. */
export async function assertSessionRuntimeCompatible(input: {
  providerId: string;
  surface: HarnessSessionSurface;
  descriptor: SessionBundleDescriptor;
  executable: string;
  versionLine?: RegExp;
  executionContext: IExecutionContext;
  env?: Record<string, string>;
  runtimeExecutable?: string;
  fileStamp?: (file: string) => string | null;
  signal?: AbortSignal;
}): Promise<string> {
  return (await resolveSessionRuntimeCompatible(input)).executable;
}
