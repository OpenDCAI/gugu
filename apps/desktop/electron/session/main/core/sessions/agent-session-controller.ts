import { AGENT_SESSION_ACTIONS, type AgentSessionActionName } from '@gugu/session-core/session-record/contract';
import { createRPCController } from '@shared/lib/ipc/rpc';

/** 怎么答 `agentSession.<动作>`(形状、调用方、执行)由宿主主进程接上,与 `setOtherMachines` 同一个做法。 */
export type AgentSessionHost = (name: AgentSessionActionName, caller: unknown, action: unknown) => Promise<unknown>;

let host: AgentSessionHost | null = null;

export function setAgentSessionHost(next: AgentSessionHost | null): void {
  host = next;
}

/** agent 的 session_* 跨机器:另一台机器经 `taskhost.call` 交给这台执行的动作,一个动作一个方法。 */
export const agentSessionController = createRPCController(
  Object.fromEntries(AGENT_SESSION_ACTIONS.map((name) => [name, (caller: unknown, action: unknown) => {
    if (!host) throw Object.assign(new Error('the task page on that machine has not finished starting; try again shortly'), { code: 'host_not_ready' });
    return host(name, caller, action);
  }])) as Record<AgentSessionActionName, (caller: unknown, action: unknown) => Promise<unknown>>,
);
