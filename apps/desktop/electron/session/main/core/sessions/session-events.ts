import type { AgentProviderId } from '@gugu/session-plugins/agents';
import { HookCore, type Hookable } from '@main/lib/hookable';
import { log } from '@main/lib/logger';
import type { Session } from '@shared/core/sessions/sessions';

export type SessionCrudHooks = {
  'session:created': (session: Session) => void | Promise<void>;
  'session:renamed': (
    sessionId: string,
    projectId: string,
    newTitle: string
  ) => void | Promise<void>;
  'session:deleted': (sessionId: string) => void | Promise<void>;
  /**
   * spec session-graph:归档 = 这条会话离开会话列表。搜索面必须跟着走 —— 一条列表里点不到的会话
   * 还能从命令面板搜出来,那「归档」只做了一半。
   */
  'session:archived': (sessionId: string) => void | Promise<void>;
  'session:input-submitted': (params: {
    projectId: string;
    sessionId: string;
    providerId: AgentProviderId;
  }) => void | Promise<void>;
};

class SessionEvents implements Hookable<SessionCrudHooks> {
  private readonly _core = new HookCore<SessionCrudHooks>((name, e) =>
    log.error(`SessionEvents: ${String(name)} hook error`, e)
  );

  on<K extends keyof SessionCrudHooks>(name: K, handler: SessionCrudHooks[K]) {
    return this._core.on(name, handler);
  }

  _emit<K extends keyof SessionCrudHooks>(
    name: K,
    ...args: Parameters<SessionCrudHooks[K]>
  ): void {
    this._core.callHookBackground(name, ...args);
  }
}

export const sessionEvents = new SessionEvents();
