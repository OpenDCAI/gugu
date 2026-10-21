import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import semver from 'semver';
import type { HarnessPresenceFile, HarnessPresenceStatus, HooksDescriptor } from '@gugu/session-core/agents/plugins';
import { agentStatusWriter } from '@main/core/agent-status/agent-status-writer';
import { log } from '@main/lib/logger';
import { agentHookService } from './agent-hook-service';
import { isAppFocused } from './app-focus';

/**
 * spec hook-status-derivation「打断边:会话在场文件」—— hooks 不报打断(在批准框上或回合中按 Esc,一条 hook 都不来),
 * harness 自己的会话在场文件却在 0.2 s 内变成 `idle`。这里只读出这一件事:**在跑或在等的会话停下了**。
 *
 * - 只在写入者认为它在跑或在等时读(`isActive`):Esc 只可能发生在这时;闲着的会话零开销(标着失效时例外,读到能撤为止)。
 * - 定时读,❌ 文件事件:mac1 负载高时 fseventsd 会晚几分钟甚至不送(#7371)。最坏延迟 = 一个间隔 + 一次读。
 * - 只有 `busy` / `waiting` → `idle` 是打断;`shell` → `idle` 是后台跑完(它走 harness 自己注入的那一轮),不报。
 *   正常做完时 Stop hook 先到(同步 hook,harness 等它跑完才收尾),写入者已经停下,这条被翻译器丢掉。
 * - 声明了却读不出(没出现、缺字段、不认识的取值、不是这个进程的)⇒ `onFault(原因)`,❌ 默默退回「Esc 不更新」。
 */
export type PresenceLocation =
  /** 咕咕直接起的进程:pty 的子进程就是 harness 本身。 */
  | { kind: 'pid'; pid: number }
  /** tmux 里接回的会话:咕咕不知道里面的进程号,按 harness 会话 id 找一次,找到后锁定进程号。 */
  | { kind: 'session'; sessionId: string };

export interface PresenceWatchFs {
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
}

const nodeFs: PresenceWatchFs = {
  readFile: (path) => readFile(path, 'utf8'),
  readdir: (path) => readdir(path),
};

export const PRESENCE_POLL_MS = 500;
/** 在跑或在等了这么久还没有它的在场文件 = 声明的协议不成立。 */
export const PRESENCE_APPEAR_WITHIN_MS = 10_000;

export function watchPresenceInterrupt(options: {
  presence: HarnessPresenceFile;
  /** 这次 spawn 的配置目录(`presence.configDirEnvVar` 或 `<HOME>/<defaultConfigDirName>`)。 */
  configRoot: string;
  location: PresenceLocation;
  isActive: () => boolean;
  onInterrupted: () => void;
  /** 读不出的原因;`null` = 又读得出了。只在变化时调。 */
  onFault: (message: string | null) => void;
  fs?: PresenceWatchFs;
  now?: () => number;
  intervalMs?: number;
}): () => void {
  const { presence, location, isActive, onInterrupted } = options;
  const fs = options.fs ?? nodeFs;
  const now = options.now ?? Date.now;
  const directory = join(options.configRoot, presence.directory);
  let pid: number | null = location.kind === 'pid' ? location.pid : null;
  let last: HarnessPresenceStatus | null = null;
  let activeSince: number | null = null;
  let fault: string | null = null;
  let reading = false;

  const setFault = (message: string | null) => {
    if (message === fault) return;
    fault = message;
    options.onFault(message);
  };
  const overdue = () => activeSince !== null && now() - activeSince > PRESENCE_APPEAR_WITHIN_MS;

  const findBySession = async (sessionId: string): Promise<number | null> => {
    const names = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      const text = await fs.readFile(join(directory, name)).catch(() => null);
      if (text === null) continue;
      try {
        const record = presence.parse(text);
        if (record.sessionId === sessionId) return record.pid;
      } catch {
        // 别人的、正写到一半的文件不是这条会话的证据;这条会话自己的文件读不出会在锁定之后报。
      }
    }
    return null;
  };

  const tick = async () => {
    const active = isActive();
    // 闲着的会话不读 —— 除非还标着失效:那时接着读,读得出就撤掉标记(❌ 让一句过时的「失效」挂到下一轮)。
    if (!active) {
      last = null;
      activeSince = null;
      if (fault === null) return;
    } else {
      activeSince ??= now();
    }
    if (pid === null && location.kind === 'session') {
      pid = await findBySession(location.sessionId);
      if (pid === null) {
        if (overdue()) setFault(`no ${presence.directory}/<pid>.json for session ${location.sessionId} under ${options.configRoot}`);
        return;
      }
    }
    const path = join(directory, `${pid}.json`);
    let text: string;
    try {
      text = await fs.readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') setFault(`${path}: ${String(error)}`);
      else if (overdue()) setFault(`${path} did not appear`);
      return;
    }
    let status: HarnessPresenceStatus;
    try {
      const record = presence.parse(text);
      if (record.pid !== pid) throw new Error(`belongs to pid ${record.pid}`);
      status = record.status;
    } catch (error) {
      setFault(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    setFault(null);
    if (!active) return;
    if (status === 'idle' && (last === 'busy' || last === 'waiting')) onInterrupted();
    last = status;
  };

  const timer = setInterval(() => {
    if (reading) return;
    reading = true;
    void tick()
      .catch((error: unknown) => setFault(String(error)))
      .finally(() => {
        reading = false;
      });
  }, options.intervalMs ?? PRESENCE_POLL_MS);
  return () => clearInterval(timer);
}

/**
 * 一次 spawn 的会话在场读者:这一家声明了 `hooks.presence` 且这一次的版本够,才起(版本不够也是读不出,照实标)。打断翻成已有的
 * `stop outcome=cancelled` 送进 hook 总线;读不出就记 log.error,并经写入者在会话上标出状态来源失效 ——
 * 任务照常起,hooks 照常,只是 Esc 那一条边补不上。
 * 返回停止函数(进程退出时调);没起就返回 `undefined`。
 */
export function startPresenceInterrupt(input: {
  plugin: { capabilities: { hooks: HooksDescriptor }; behavior: { hooks?: { presence?: HarnessPresenceFile } } };
  harnessVersion: string | null;
  spawnEnv: Record<string, string | undefined>;
  location: PresenceLocation;
  sessionId: string;
  projectId: string;
  providerId: string;
}): (() => void) | undefined {
  const hooks = input.plugin.capabilities.hooks;
  const declared = hooks.kind === 'config' && 'presence' in hooks ? hooks.presence : undefined;
  if (!declared) return undefined;
  // 声明了却没注册读者 = 插件代码写错了:spawn 时就响亮(测试抓得到)。
  const presence = input.plugin.behavior.hooks?.presence;
  if (!presence) throw new Error(`${input.providerId} declares hooks.presence but registers no presence reader`);
  const { sessionId, projectId, providerId } = input;
  // 运行时读不出的事实(版本、进程号):状态来源坏了,❌ 连带让任务起不来 —— 记下、标出,hooks 照常。
  const fault = (message: string) => {
    log.error('PresenceInterrupt: the session presence this harness declares cannot be read', {
      sessionId,
      providerId,
      harnessVersion: input.harnessVersion,
      reason: message,
    });
    agentStatusWriter.reportStatusSourceFault({ sessionId, projectId, message });
  };
  if (input.harnessVersion === null) {
    fault(`writes session presence since ${declared.sinceVersion}, but the version of this spawn is unknown`);
    return undefined;
  }
  if (!semver.gte(input.harnessVersion, declared.sinceVersion)) {
    fault(`writes session presence since ${declared.sinceVersion}; this spawn is ${input.harnessVersion}, so Esc will not update the status`);
    return undefined;
  }
  if (input.location.kind === 'pid' && !Number.isInteger(input.location.pid)) {
    fault('the pty reports no pid to find its presence file by');
    return undefined;
  }
  const configRoot = input.spawnEnv[presence.configDirEnvVar]?.trim()
    || join(input.spawnEnv.HOME?.trim() || homedir(), presence.defaultConfigDirName);
  return watchPresenceInterrupt({
    presence,
    configRoot,
    location: input.location,
    isActive: () => agentStatusWriter.isWorkingOrWaiting(sessionId),
    onInterrupted: () => {
      agentHookService.emitAgentEvent(
        { type: 'stop', providerId, projectId, sessionId, timestamp: Date.now(), payload: { outcome: 'cancelled' } },
        isAppFocused(),
      );
    },
    onFault: (message) => {
      if (message !== null) fault(message);
      else agentStatusWriter.reportStatusSourceFault({ sessionId, projectId, message: null });
    },
  });
}
