import type { AgentPluginHost } from '@gugu/session-core/agents/plugins';
import type { ReplicaHostDependencyLedger } from '@gugu/session-core/deps/runtime';
import type { PtySpawner } from '@gugu/session-core/pty';
import type { Logger } from '@gugu/session-shared/logger';
import type { Scope } from '@gugu/session-wire/util';
import type { AuthExpiryMarks } from './auth-expiry';

export interface AgentConfigRuntimeDeps {
  scope: Scope;
  agentHost: AgentPluginHost;
  ptySpawner: PtySpawner;
  logger: Logger;
  /**
   * 主进程递过来的那本账的副本(#6101)。`agentHost` 的依赖管理器读的就是它 ——
   * 这里留一个引用,是为了在新快照到达时把它换上并重探一遍。
   *
   * 不给 = 没有属主推账(独立跑 runtime 的测试与工具),那时依赖管理器只答得出
   * 「PATH 赢家是什么」,`syncHostDependencyLedger` 如实拒绝。
   */
  hostDependencyLedger?: ReplicaHostDependencyLedger;
  /** #6264「登录已失效」标记(带落盘)。不给 = 只在内存里。 */
  authExpiry?: AuthExpiryMarks;
}
