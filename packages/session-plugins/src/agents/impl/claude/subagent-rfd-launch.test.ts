/**
 * ACP v2 的子智能体是 RFD 形态:父会话上的 `subagent_update` 宣布一个子会话,不说是哪次 Agent 调用派的它
 * (AIR 的 `subagent_spawned` 带 `launchToolCallId`)。认亲靠的是那次调用的结果里的 `agentId`(登记册按会话号归一),
 * 所以两种形态立出同样的行,❌ 不需要别名。
 */
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { AcpTranscriptParser, decodeSessionUpdate } from '@gugu/session-core/acp';
import { describe, expect, it } from 'vitest';
import { enrichClaudeUpdate } from './acp-transform';

const decode = (raw: Record<string, unknown>) => enrichClaudeUpdate(decodeSessionUpdate(raw as never), raw as never as SessionUpdate);

const launch = {
  sessionUpdate: 'tool_call',
  toolCallId: 'toolu_agent',
  title: 'Background review',
  kind: 'think',
  status: 'in_progress',
  rawInput: { description: 'Background review', prompt: 'Review the diff', subagent_type: 'general-purpose', run_in_background: true },
  _meta: { claudeCode: { toolName: 'Agent' } },
};
const announce = {
  sessionUpdate: 'subagent_update',
  sessionId: 'a2',
  title: 'general-purpose',
  description: 'Background review',
  capabilities: { cancel: {} },
  state: { state: 'running' },
};

/** AIR's announcement of the same child: it names the launching call itself (`launchToolCallId`). */
const airSpawned = {
  sessionUpdate: 'subagent_spawned',
  subagentSessionId: 'a2',
  name: 'general-purpose',
  task: 'Background review',
  capabilities: { cancel: true },
  launchToolCallId: 'toolu_agent',
};
/** The Agent call's result, which names the child it launched. */
const launched = {
  sessionUpdate: 'tool_call_update',
  toolCallId: 'toolu_agent',
  status: 'completed',
  _meta: { claudeCode: { toolName: 'Agent', toolResponse: { isAsync: true, status: 'async_launched', agentId: 'a2' } } },
};

function rows(events: Array<Record<string, unknown>>) {
  const parser = new AcpTranscriptParser({ sessionId: 's' });
  parser.pushEvent({ kind: 'message', role: 'user', messageId: 'u1', text: 'review it' } as never, 1);
  for (const [i, raw] of events.entries()) parser.pushEvent(decode(raw), 2 + i);
  return (parser.activeTurn?.items ?? []).map((item) => {
    const { kind, toolCallId, subagentSessionId, agentToolUseId } = item as Record<string, unknown>;
    return { kind, toolCallId, subagentSessionId, agentToolUseId };
  });
}

describe('the RFD subagent of a Claude Agent call', () => {
  it('builds the rows that AIR\'s announcement builds', () => {
    const air = rows([launch, airSpawned, launched]);
    expect(air.map((row) => row.kind)).toEqual(['message', 'spawn-subagent-tool-call', 'spawn-subagent-tool-call']);
    expect(rows([launch, announce, launched])).toEqual(air);
  });
});
