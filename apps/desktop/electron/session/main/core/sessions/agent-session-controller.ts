import { AGENT_SESSION_ACTIONS, type AgentSessionActionName } from '@gugu/session-core/session-record/contract';
import { assistantWorkIntentSchema } from '@gugu/core/shared/assistantWorkIntent';
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


/** Separate capability: an older host must reject before accidentally starting an executor. */
export const assistantWorkController = createRPCController({
  prepare(caller: unknown, raw: unknown) {
    const action = raw as Record<string, unknown> | null;
    if (!action || action.action !== 'spawn' || (caller as { kind?: unknown })?.kind === 'app') throw new Error('Work preparation requires an agent spawn');
    assistantWorkIntentSchema.parse(action.assistant_work);
    if (!host) throw Object.assign(new Error('Task host is not ready'), { code: 'host_not_ready' });
    return host('spawn', caller, action);
  },
});
