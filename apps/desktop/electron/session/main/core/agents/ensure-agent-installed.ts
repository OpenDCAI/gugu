import type { DependencyInstallError, InstallProgressReport } from '@gugu/session-core/deps/runtime/types';

/**
 * 在这台机器上建 agent / 会话,而它还没装这家 agent 时,先装上(#6264 product spec 第 6 条:
 * 「从任何一端在 server 上新建 agent 时,挑的 agent 那台机器上还没装的,创建时自动装上」)。
 *
 * **一个装法、两个入口**:云端 agent.create(embedded-boot 的 ensureSessionpageAgentInstalled)与
 * 会话页路由 `sessionTimeline.sessionCreate`(session-timeline/create-session.ts)都走这里;装法本身是
 * 设置页「安装」按钮那同一个入口(agentsController.install:同样的选源、进度事件、收尾探测)。
 * ❌ 不另写第二条装法。
 */

type InstallResult = { success: true } | { success: false; error: DependencyInstallError };

export interface EnsureAgentInstalledDeps {
  /** 这台机器上所有 agent 至少探过一次(没探过的「missing」是编出来的,见 agentsController.list)。 */
  probe: () => Promise<void>;
  /** 探测后的状态;`available` 以外的一律当作要装。 */
  status: (provider: string) => Promise<string | undefined>;
  /** `signal`:没人再等这次安装了(发起方都取消了)就停下它(#7199)。 */
  install: (provider: string, signal: AbortSignal) => Promise<InstallResult>;
  log?: {
    info: (fields: Record<string, unknown>, msg: string) => void;
  };
}

/** 装失败:带着安装器的原始错误,由调用方按自己的出口翻成人话(见 describeAgentInstallFailure)。 */
export class AgentInstallFailedError extends Error {
  readonly code = 'harness_install_failed';
  constructor(
    readonly provider: string,
    readonly cause: DependencyInstallError | Error,
  ) {
    super(describeAgentInstallFailure(provider, cause));
    this.name = 'AgentInstallFailedError';
  }
}

/** npm / mise 的输出里夹着 ANSI 与盲文进度点阵,挑一行能说明原因的给人看(完整输出进日志)。 */
function causeLine(output: string | undefined): string | null {
  if (!output) return null;
  const lines = output
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u2800-\u28ff]+/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  // 越具体越优先:系统错误码 / 权限 / 网络 → 安装器自己的 ERROR 行 → 任意 fail/error 行 → 最后一行。
  // 错误码按大小写认(`/i` 下 `\bE[A-Z]+` 会命中任何 e 开头的词,比如包名 earendil —— 实测挑错过一次)。
  const specific = lines.find(
    (line) =>
      /\bE(?:ACCES|PERM|NOENT|NOSPC|NOTFOUND|CONNRESET|CONNREFUSED|TIMEDOUT|AI_AGAIN|EXIST)\b/.test(line) ||
      /permission denied|os error \d+|network|timed out|certificate/i.test(line),
  );
  const installerError = lines.find((l) => /\bERROR\b/.test(l) && !/\bVersion:|--verbose/.test(l));
  const line = specific ?? installerError ?? lines.find((l) => /fail|error/i.test(l)) ?? lines[lines.length - 1];
  return line ? line.slice(0, 300) : null;
}

/**
 * 装失败的那句人话 —— 中文在前、英文在后,因为这句话要经设备 RPC 送回发起方(手机、另一台电脑),
 * 那边的界面原样显示它,而这台机器不知道对面是什么语言。
 */
export function describeAgentInstallFailure(provider: string, error: DependencyInstallError | Error): string {
  const head = `在这台机器上安装 ${provider} 失败 / Failed to install ${provider} on this machine`;
  if (error instanceof Error) return `${head}: ${error.message}`;
  const reason = ((): string => {
    switch (error.type) {
      case 'unknown-dependency':
        return `咕咕不认识这个 agent / unknown agent (${error.id})`;
      case 'no-install-command':
        return '这台机器的系统上没有可用的安装方式 / no install method for this platform';
      case 'not-detected-after-install':
        return '安装命令跑完了,但仍找不到它 / installed, but still not found afterwards';
      case 'unsupported-host':
        return '这台机器上装不了,请先手动安装 / cannot install here, install it manually';
      case 'permission-denied':
        return '权限不够 / permission denied';
      case 'stalled':
        return `安装 ${Math.round(error.idleMs / 1000)} 秒没有任何进展,已停止 / install stalled and was stopped`;
      case 'cancelled':
        return '安装被中止 / install was cancelled';
      case 'pty-open-failed':
        return `开不了终端来跑安装命令 / could not open a terminal: ${error.message}`;
      case 'command-failed':
        return '安装命令出错 / install command failed';
    }
  })();
  const detail = 'output' in error ? causeLine(error.output) : null;
  const stuck = 'lastProgress' in error && error.lastProgress ? describeStuckAt(error.lastProgress) : null;
  return [`${head}: ${reason}`, stuck, detail].filter(Boolean).join(' — ');
}

const PHASE_WORDS: Record<InstallProgressReport['phase'], string> = {
  starting: '开始安装 / starting',
  resolving: '取清单 / fetching the release manifest',
  downloading: '下载 / downloading',
  installing: '解压安装 / unpacking',
  verifying: '校验 / verifying',
};

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

/**
 * 停在哪一步(#7199):取清单 / 下载(已下多少、共多少、多快)/ 解压安装 / 校验。
 * 字节数都是实测(mise 自己报的,或落点目录量出来的);缺哪样就不说哪样,❌ 不估。
 */
export function describeStuckAt(progress: InstallProgressReport): string {
  const amounts: string[] = [];
  if (progress.bytesDone !== undefined) {
    amounts.push(
      progress.bytesTotal !== undefined
        ? `${megabytes(progress.bytesDone)}/${megabytes(progress.bytesTotal)} MB`
        : `${megabytes(progress.bytesDone)} MB`,
    );
  }
  if (progress.bytesPerSecond !== undefined) amounts.push(`${megabytes(progress.bytesPerSecond)} MB/s`);
  const seconds = Math.round(progress.elapsedMs / 1000);
  amounts.push(`${seconds}s`);
  return `停在:${PHASE_WORDS[progress.phase]}(${amounts.join(', ')}) / stopped at ${progress.phase}`;
}

export function createEnsureAgentInstalled(deps: EnsureAgentInstalledDeps) {
  /**
   * 同一家 agent 同时只装一次:两个入口(或手机连点两下)撞在一起时,后到的等同一趟,❌ 不报「已有安装在跑」。
   * `waiting`:还在等这一趟的人数。每个人自己取消只是不再等;**所有人都取消了**才停下这次安装(#7199)——
   * 一个人取消,❌ 连累别人等着的那一趟。不带取消信号的等待方永远算在里面。
   */
  const inFlight = new Map<string, { done: Promise<void>; controller: AbortController; waiting: number }>();

  async function installOnce(provider: string, signal: AbortSignal): Promise<void> {
    deps.log?.info({ provider }, '这台机器上还没装这个 agent,先安装');
    const startedAt = Date.now();
    let result: InstallResult;
    try {
      result = await deps.install(provider, signal);
    } catch (error) {
      throw new AgentInstallFailedError(provider, error instanceof Error ? error : new Error(String(error)));
    }
    if (!result.success) throw new AgentInstallFailedError(provider, result.error);
    deps.log?.info({ provider, elapsedMs: Date.now() - startedAt }, 'agent 安装完成');
  }

  return async function ensureAgentInstalled(provider: string, signal?: AbortSignal): Promise<void> {
    await deps.probe();
    if ((await deps.status(provider)) === 'available') return;
    signal?.throwIfAborted();
    let running = inFlight.get(provider);
    // 那一趟已经因为大家都取消而在收尾:❌ 挂上去跟着报「取消」—— 等它收完(安装器的锁放开),再起一趟新的。
    while (running?.controller.signal.aborted) {
      await running.done.catch(() => {});
      running = inFlight.get(provider);
    }
    if (!running) {
      const controller = new AbortController();
      const entry = { controller, waiting: 0, done: Promise.resolve() };
      entry.done = installOnce(provider, controller.signal).finally(() => {
        if (inFlight.get(provider) === entry) inFlight.delete(provider);
      });
      inFlight.set(provider, entry);
      running = entry;
    }
    const entry = running;
    entry.waiting += 1;
    if (!signal) return await entry.done;
    let stopWaiting = () => {};
    const abandoned = new Promise<never>((_, reject) => {
      stopWaiting = () => {
        entry.waiting -= 1;
        if (entry.waiting === 0) entry.controller.abort(signal.reason);
        reject(signal.reason ?? new Error('aborted'));
      };
      signal.addEventListener('abort', stopWaiting, { once: true });
    });
    abandoned.catch(() => {});
    try {
      return await Promise.race([entry.done, abandoned]);
    } finally {
      signal.removeEventListener('abort', stopWaiting);
    }
  };
}

/**
 * 真正的那一份。依赖**用时再取**:agents/controller 会拖进 secrets / electron 一整片依赖图,
 * 顶层 import 会让加载它的单测先得备齐 electron(见 create-session.ts agentPayloads 抬头)。
 */
export const ensureAgentInstalled = createEnsureAgentInstalled({
  probe: async () => {
    const { ensureAgentDependenciesProbed, localDependencyManager } = await import(
      '@main/core/dependencies/dependency-managers'
    );
    await ensureAgentDependenciesProbed(localDependencyManager);
  },
  status: async (provider) => {
    const { localDependencyManager } = await import('@main/core/dependencies/dependency-managers');
    const { toAgentProviderId } = await import('@main/core/agents/plugin-registry');
    return localDependencyManager.get(toAgentProviderId(provider))?.status;
  },
  install: async (provider, signal) => {
    const [{ agentsController }, { toAgentProviderId }] = await Promise.all([
      import('@main/core/agents/controller'),
      import('@main/core/agents/plugin-registry'),
    ]);
    return agentsController.install(toAgentProviderId(provider), undefined, undefined, { signal });
  },
  log: {
    info: (fields, msg) => {
      void import('@main/lib/logger').then(({ log }) => log.info({ scope: 'agents/ensure-installed', ...fields }, msg));
    },
  },
});

/**
 * agent 装好了,但这台机器上的咕咕缺它运行要用的组件(ACP 适配器 / 某个模块解析不到)。
 * 与「装失败」是两件事:那边的下一步是「检查网络、手动装 agent」,这边 agent 本身没问题,
 * 缺的是咕咕这一侧 —— 下一步是把那台机器上的咕咕更新好。
 * 典型是 #6264 的 server 包漏带适配器:`Cannot find module '@agentclientprotocol/claude-agent-acp/…'`。
 */
export const HARNESS_RUNTIME_MISSING_CODE = 'harness_runtime_missing';

/** 失败原文是不是「模块解析不到」(CJS 的 MODULE_NOT_FOUND / ESM 的 ERR_MODULE_NOT_FOUND 两种说法)。 */
export function isHarnessRuntimeMissing(detail: string): boolean {
  return /\bCannot find (?:module|package)\b|\bERR_MODULE_NOT_FOUND\b|\bMODULE_NOT_FOUND\b/.test(detail);
}

/** 同 describeAgentInstallFailure:中文在前、英文在后,原文只进日志。 */
export function describeHarnessRuntimeMissing(provider: string): string {
  return `这台机器上的咕咕缺少运行 ${provider} 所需的组件,请把那台机器上的咕咕更新到最新版本后再试 / `
    + `Gugu on this machine is missing a component ${provider} needs to run; update Gugu on that machine and try again`;
}
