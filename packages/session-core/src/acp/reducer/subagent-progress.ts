import type { AgentState } from '../models/agents';
import type { ToolNode, TranscriptItem, TranscriptTurn } from '../models/turns';
import type { ParserState } from './reducer';

/** Project a native child's current facts onto its original launch row without changing that call's outcome. */
export function projectSubagentProgress(state: ParserState): ParserState {
  const owners = new Map(state.agents.filter((agent) => agent.subagentSessionId).map((agent) => [agent.toolCallId, agent]));
  if (owners.size === 0) return state;
  function nodes<T extends TranscriptItem | ToolNode>(items: T[]): T[] {
    let changed = false;
    const next = items.map((item) => {
      let result: T = item;
      if (item.kind === 'spawn-subagent-tool-call') {
        const agent = owners.get(item.toolCallId);
        if (agent && differs(item, agent)) result = { ...item, agentStatus: agent.status, canCancel: agent.canCancel === true,
          agentStartedAt: agent.startedAt, outputText: agent.output, reasoningText: agent.reasoning,
          ...(agent.model ? { model: agent.model } : {}),
        };
      }
      if ('children' in result && result.children?.length) {
        const children = nodes(result.children);
        if (children !== result.children) result = { ...result, children };
      }
      changed ||= result !== item;
      return result;
    });
    return changed ? next : items;
  }
  function turn(value: TranscriptTurn): TranscriptTurn {
    const items = nodes(value.items);
    return items === value.items ? value : { ...value, items };
  }
  const committed = state.transcript.committed.map(turn);
  const changed = committed.some((value, index) => value !== state.transcript.committed[index]);
  const active = state.transcript.active ? turn(state.transcript.active) : null;
  return !changed && active === state.transcript.active ? state : { ...state, transcript: {
    committed: changed ? committed : state.transcript.committed, active,
  } };
}

function differs(item: Extract<ToolNode, { kind: 'spawn-subagent-tool-call' }>, agent: AgentState): boolean {
  return item.agentStatus !== agent.status || item.canCancel !== (agent.canCancel === true) || item.agentStartedAt !== agent.startedAt ||
    item.outputText !== agent.output || item.reasoningText !== agent.reasoning ||
    (agent.model !== undefined && item.model !== agent.model);
}
