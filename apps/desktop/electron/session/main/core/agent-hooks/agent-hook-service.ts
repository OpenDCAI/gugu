import type { IDisposable, IInitializable } from '@gugu/session-shared';
import path from 'node:path';
import { app } from 'electron';
import { getPlugin } from '@main/core/agents/plugin-registry';
import { sessionEvents } from '@main/core/sessions/session-events';
import { setProviderSessionId } from '@main/core/sessions/set-session-id';
import { HookCore, type Hookable } from '@main/lib/hookable';
import { log } from '@main/lib/logger';
import type { AgentEvent } from '@shared/core/agents/agentEvents';
import { parseHookEvent } from './event-enricher';
import { forgetSessionAutonomy } from './turn-autonomy';
import { HookServer, type HookSource, type PersistedHookSource } from './hook-server';
import { EndpointPorts, PersistedRecords } from '@main/lib/stable-endpoint';
import { isAppFocused } from './app-focus';
import {
  applyHookToAuthExpiry,
  sessionUsesPlatformCredentials,
  type AuthExpiryWriter,
} from '@main/core/agent-config/auth-expiry-from-turns';

/** 用时再 import:agent-config 那一侧的 worker ❌ 因为钩子服务起来就被提前拉起(同 acp runtime-process/host)。 */
const hookAuthExpiryWriter: AuthExpiryWriter = {
  mark: async (providerId, sessionId) => (await import('@main/core/agent-config/runtime-process/host')).markAgentAuthExpired(providerId, sessionId),
  clear: async (providerId, sessionId) => (await import('@main/core/agent-config/runtime-process/host')).clearAgentAuthExpired(providerId, sessionId),
  log: (message, detail) => log.warn(message, detail),
};

/** #6264「编程」终端会话里登录被拒同样回写「登录已失效」;正常结束一轮就撤掉(见 auth-expiry-from-turns.ts)。 */
function learnAuthExpiryFromEvent(event: AgentEvent): void {
  if (event.type !== 'error' && event.type !== 'stop') return;
  void applyHookToAuthExpiry(
    {
      providerId: event.providerId,
      sessionId: event.sessionId,
      type: event.type,
      signInRequired: event.payload.signInRequired,
      platformCredentials: sessionUsesPlatformCredentials(event.sessionId),
    },
    hookAuthExpiryWriter
  );
}

export type AgentHookServiceHooks = {
  'agent:event': (event: AgentEvent, appFocused: boolean) => void | Promise<void>;
  'agent:session': (input: {
    sourceId: string;
    sessionId: string;
    projectId: string;
    providerId: string;
    providerSessionId: string;
  }) => void | Promise<void>;
};

export function providerSupportsNativeStartHook(providerId: string): boolean {
  const hooks = getPlugin(providerId).capabilities.hooks;
  return hooks.kind !== 'none' && hooks.supportedEvents.includes('start');
}

/**
 * 终端腿的回合起点已经有一个真生产者:宿主适配器从引擎自己的事件流发布回合边界,经 `onTurnLifecycle`
 * relay 进来 —— opencode / mimocode 的 serve/attach(SSE `session.status{busy}` → `session.idle/error`)、
 * codex 的 app-server(`turn/started` → `turn/completed`)。终点只在真起过回合之后才有。
 * 这种腿上再按回车合成一条 start,就是一个**没有终点的起点**:空回车、斜杠命令 / 对话框里的回车、
 * 起回合之前就失败的提交都不起回合,working 于是永远没人拉回(opencode #6391、codex #6410)。
 * 适配器按 `resolveSessionTuiHostAdapter` 同一个顺序取:描述符上的 `hostAdapter`,否则 behavior 选的那个。
 */
const TURN_LIFECYCLE_RELAY_HOST_ADAPTERS: ReadonlySet<string> = new Set([
  'opencode-serve-attach-v1',
  'codex-app-server-v1',
]);

export function sessionTuiTurnStartPublishedByHostAdapter(providerId: string): boolean {
  const plugin = getPlugin(providerId);
  const hostAdapter = plugin.capabilities.sessionBundle.sessionpage['tui']?.hostAdapter
    ?? plugin.behavior.sessionBundle?.sessionTuiHostAdapter;
  return hostAdapter !== undefined && TURN_LIFECYCLE_RELAY_HOST_ADAPTERS.has(hostAdapter);
}

async function handleSessionEvent(
  ctx: { sessionId: string; projectId: string; providerId: string },
  providerSessionId: string
): Promise<string | undefined> {
  // Provider-specific session-id validation lives in the plugin (e.g. Droid UUIDs,
  // Amp 'T-' threads). Absent a validator the id is accepted as-is.
  const validateProviderSessionId = getPlugin(ctx.providerId).behavior?.sessions?.validateProviderSessionId;
  if (validateProviderSessionId && !validateProviderSessionId(providerSessionId)) return undefined;

  const result = await setProviderSessionId(ctx.sessionId, providerSessionId);
  if (!result.success) {
    log.warn('AgentHookService: failed to persist session id', {
      sessionId: ctx.sessionId,
      error: result.error.type,
    });
    return undefined;
  }

  return providerSessionId.trim();
}

/**
 * hook 入口:harness 的 hook 经 hook server 到这里,解析成 `AgentEvent` 发到 'agent:event' —— ACP 桥、终端腿的
 * 回车合成、宿主中转的回合边也都往这同一条总线上发。状态由写入者订这条总线得出(spec agent-status-writer),
 * 这里 ❌ 写状态。
 */
class AgentHookService implements IInitializable, IDisposable, Hookable<AgentHookServiceHooks> {
  private server = new HookServer();
  private readonly disposers: Array<() => void> = [];
  private readonly _hooks = new HookCore<AgentHookServiceHooks>((name, e) =>
    log.error(`AgentHookService: ${String(name)} hook error`, e)
  );

  on<K extends keyof AgentHookServiceHooks>(name: K, handler: AgentHookServiceHooks[K]) {
    return this._hooks.on(name, handler);
  }

  emitAgentEvent(event: AgentEvent, appFocused: boolean): void {
    this._hooks.callHookBackground('agent:event', event, appFocused);
  }

  /**
   * 不经 CLI 钩子服务器的终端会话回合边界(codex app-server / opencode serve 的 sidecar)。
   * 与钩子那条腿同一套后续:先把回合终局落到「登录已失效」标记上,再照常播状态事件(#6264)。
   */
  emitProviderLifecycleEvent(event: AgentEvent, appFocused: boolean): void {
    learnAuthExpiryFromEvent(event);
    this.emitAgentEvent(event, appFocused);
  }

  async initialize(): Promise<void> {
    this.useStableEndpoint();
    this.disposers.push(
      sessionEvents.on('session:deleted', (sessionId) => forgetSessionAutonomy(sessionId))
    );

    this.disposers.push(
      sessionEvents.on(
        'session:input-submitted',
        ({ projectId, sessionId, providerId }) => {
          if (
            !providerSupportsNativeStartHook(providerId)
            && !sessionTuiTurnStartPublishedByHostAdapter(providerId)
          ) {
            const agentEvent: AgentEvent = {
              type: 'start',
              providerId,
              projectId,
              sessionId,
              timestamp: Date.now(),
              payload: {},
            };
            this.emitAgentEvent(agentEvent, isAppFocused());
          }
        }
      )
    );

    await this.server.start(async (raw) => {
      let parsed;
      try {
        parsed = await parseHookEvent(raw);
      } catch (error) {
        // 一条读不懂的 hook 是 harness 与我们的协议对不上(例:Claude 的 Notification 缺 notification_type):
        // 响亮地记下来并带上这次 spawn 的 harness 版本,但只丢这一条事件 —— 会话照跑、状态不动。
        log.error('AgentHookService: hook event does not match the harness protocol; event dropped', {
          ptyId: raw.ptyId,
          type: raw.type,
          harnessVersion: raw.harnessVersion,
          error: String(error),
        });
        return;
      }

      if (parsed.kind === 'ignore') return;

      if (parsed.kind === 'session') {
        await handleSessionEvent(parsed.ctx, parsed.providerSessionId)
          .then((providerSessionId) => {
            if (!providerSessionId) return;
            this._hooks.callHookBackground('agent:session', {
              ...parsed.ctx,
              providerSessionId,
            });
          })
          .catch((error) => {
            log.warn('AgentHookService: failed to persist session id', {
              ptyId: raw.ptyId,
              error: String(error),
            });
          });
        return;
      }

      const event = parsed.event;
      learnAuthExpiryFromEvent(event);
      // appFocused 只喂给下游的**提示音**(用户可在任务设置里选「只在未聚焦时响」);
      // 系统通知本身不看聚焦,见 maybeShowNotification 的注释。
      const appFocused = isAppFocused();
      this.emitAgentEvent(event, appFocused);
    });
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) {
      dispose();
    }
    this.server.stop();
  }

  getPort(): number {
    return this.server.getPort();
  }

  /**
   * #6264 The hook port and the credentials of agents running in tmux survive a host-process restart
   * (upgrade, crash, keeper restart): they live in the account's data dir (0600). Without a data dir
   * (tests) the server behaves as before.
   */
  private useStableEndpoint(): void {
    let dataDir: string;
    try {
      dataDir = app.getPath('userData');
    } catch {
      return;
    }
    if (!dataDir) return;
    this.server.usePersistence({
      ports: new EndpointPorts(dataDir),
      sources: new PersistedRecords<PersistedHookSource>(path.join(dataDir, 'hook-sources.json')),
      log: { info: (message, fields) => log.info(message, fields), warn: (message, fields) => log.warn(message, fields) },
    });
  }

  /** The credentials a previous host process gave the agent still running in this session's tmux. */
  takeRestoredSource(ptySessionId: string): HookSource | undefined {
    return this.server.takeRestoredSource(ptySessionId);
  }

  /** Mint the hook credentials for one spawn; see {@link HookServer.createSource}. */
  createSource(ptyId: string, harnessVersion: string | null): HookSource {
    return this.server.createSource(ptyId, harnessVersion);
  }
}

export const agentHookService = new AgentHookService();
