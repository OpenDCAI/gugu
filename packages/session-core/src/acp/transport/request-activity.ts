import type { PromptRequest, PromptResponse } from '@agentclientprotocol/sdk';
import type { AcpAgentApi, AcpClient } from '../../agents/plugins/capabilities/acp';
import type { NormalizedEvent } from '../reducer/normalized-event';
import { toSerializedError } from '@gugu/session-shared';

export type RequestActivityAgent = Omit<AcpAgentApi, 'prompt'> & {
  prompt(params: PromptRequest): Promise<PromptResponse>;
};

/** v1 can report request activity, not native acceptance or autonomous foreground work. */
export function createRequestActivity(
  agent: RequestActivityAgent,
  emit: AcpClient['sessionEvent'],
  options: { interruptAtToolBoundary?: boolean } = {},
) {
  type Idle = Extract<NormalizedEvent, { kind: 'agent_state' }> & { state: 'idle' };
  const sessions = new Map<string, { pending: Set<string>; cancelled: boolean; result?: Idle; cancelledResult?: Idle; interrupting?: boolean }>();
  const tools = new Map<string, Set<string>>();
  const boundaries = new Map<string, () => void>();
  const observe = (sessionId: string, event: { kind: string; toolCallId?: string; status?: string | null }) => {
    if (!sessions.has(sessionId)) return;
    if (event.kind !== 'tool_call' && event.kind !== 'tool_update') return;
    if (!event.toolCallId) return;
    const running = tools.get(sessionId) ?? new Set<string>();
    tools.set(sessionId, running);
    if (event.status === 'completed' || event.status === 'failed') running.delete(event.toolCallId);
    else if (event.kind === 'tool_call' || event.status === 'pending' || event.status === 'in_progress') running.add(event.toolCallId);
    if (!running.size) { boundaries.get(sessionId)?.(); boundaries.delete(sessionId); }
  };
  const api = new Proxy(agent, {
    get(target, property) {
      if (property === 'interruptForMessage') return options.interruptAtToolBoundary
        ? async ({ sessionId }: { sessionId: string }) => {
          const session = sessions.get(sessionId);
          if (!session || session.cancelled || session.interrupting) return;
          session.interrupting = true;
          if (tools.get(sessionId)?.size) await new Promise<void>(resolve => boundaries.set(sessionId, resolve));
          if (sessions.get(sessionId) !== session || session.cancelled) return;
          emit({ sessionId, event: { kind: 'interrupted_for_message' } });
          await agent.cancel({ sessionId });
        } : undefined;
      if (property === 'cancel') return async (params: Parameters<AcpAgentApi['cancel']>[0]) => {
        const session = sessions.get(params.sessionId);
        if (session) session.cancelled = true;
        boundaries.get(params.sessionId)?.();
        boundaries.delete(params.sessionId);
        await target.cancel(params);
      };
      if (property === 'steer' && target.extMethod) return async (params: PromptRequest, dispatch?: Parameters<AcpAgentApi['prompt']>[1]) => {
        const result = await target.extMethod!('_session/steering', { ...params,
          _meta: { steering: { idleBehavior: 'promptRequired', delivery: 'next' } } });
        if (result.outcome !== 'injected' && result.outcome !== 'promptRequired') throw new Error(`ACP steering returned unsupported outcome '${String(result.outcome)}'`);
        if (result.outcome === 'injected' && dispatch) emit({ sessionId: params.sessionId, event: dispatch.message });
        return result.outcome;
      };
      if (property !== 'prompt') {
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (params: PromptRequest, dispatch?: Parameters<AcpAgentApi['prompt']>[1]) => {
        const requestId = dispatch?.requestId ?? crypto.randomUUID();
        const session = sessions.get(params.sessionId) ?? { pending: new Set<string>(), cancelled: false };
        sessions.set(params.sessionId, session);
        const pending = session.pending;
        pending.add(requestId);
        const send = (event: NormalizedEvent) => emit({ sessionId: params.sessionId, event });
        if (pending.size === 1) send({ kind: 'agent_state', source: 'request', state: 'running' });
        const finish = (event: Idle) => {
          if (event.stopReason !== 'cancelled') session.result = event;
          else session.cancelledResult = event;
          pending.delete(requestId);
          // A concurrent prompt's cancelled response cannot stop another live request.
          if (pending.size !== 0) return;
          sessions.delete(params.sessionId);
          tools.delete(params.sessionId);
          boundaries.get(params.sessionId)?.();
          boundaries.delete(params.sessionId);
          send(session.cancelled ? session.cancelledResult ?? event
            : event.stopReason === 'cancelled' ? session.result ?? event : event);
        };
        let response: Promise<PromptResponse>;
        try { response = target.prompt(params); }
        catch (error) { response = Promise.reject(error); }
        void response.then(response => {
          send({ kind: 'prompt_result', requestId, ...('_meta' in response ? { _meta: response._meta } : {}) });
          finish({ kind: 'agent_state', source: 'request', state: 'idle', ...response });
        }, error => {
          const cause = toSerializedError(error);
          send({ kind: 'prompt_result', requestId, error: cause });
          finish({ kind: 'agent_state', source: 'request', state: 'idle', stopReason: 'error', error: cause });
        });
        return Promise.resolve({ status: 'dispatched', requestId } as const);
      };
    },
  }) as unknown as AcpAgentApi;
  return { agent: api, observe };
}
