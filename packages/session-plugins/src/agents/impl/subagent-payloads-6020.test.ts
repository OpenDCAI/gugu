import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { AcpTranscriptParser } from '@gugu/session-core/acp/transcript-parser';
import { expect, it } from 'vitest';
import { enrichClaudeUpdate } from './claude/acp-transform';
import { enrichCodexUpdate } from './codex/acp-transform';

it.each([
  { provider: 'claude', enrich: enrichClaudeUpdate, title: 'Inspect files',
    input: { description: 'Inspect files', prompt: 'FULL_PROMPT', model: 'requested-model' },
    meta: { claudeCode: { toolName: 'Agent' } } },
  { provider: 'codex', enrich: enrichCodexUpdate, title: 'spawnAgent',
    input: { prompt: 'FULL_PROMPT', senderThreadId: 'parent', receiverThreadIds: ['child'], model: 'requested-model' },
    meta: {} },
])('#6020 $provider preserves subagent payloads across separate and sparse updates', ({ provider, enrich, title, input, meta }) => {
  const parser = new AcpTranscriptParser({ sessionId: provider, enrich });
  const events: SessionUpdate[] = [
    { sessionUpdate: 'tool_call', toolCallId: 'delegate', title, kind: 'other', status: 'in_progress', rawInput: input, _meta: meta },
    { sessionUpdate: 'tool_call_update', toolCallId: 'delegate', title, rawInput: input,
      rawOutput: { message: 'DIRECT_RESULT', details: ['complete'] },
      content: [{ type: 'content', content: { type: 'text', text: 'DIRECT_RESULT' } }], _meta: meta },
    { sessionUpdate: 'tool_call_update', toolCallId: 'delegate', status: 'completed' },
  ];
  for (const event of events) parser.push(event);
  const item = parser.activeTurn?.items.find((node) => 'toolCallId' in node && node.toolCallId === 'delegate');
  expect(item).toMatchObject({ kind: 'spawn-subagent-tool-call', status: 'done',
    rawInput: JSON.stringify(input, null, 2),
    rawOutput: JSON.stringify({ message: 'DIRECT_RESULT', details: ['complete'] }, null, 2), outputText: 'DIRECT_RESULT' });
  const replay = AcpTranscriptParser.replay(events, { sessionId: provider, enrich });
  expect(JSON.stringify(replay.committed)).toContain('FULL_PROMPT');
  expect(JSON.stringify(replay.committed)).toContain('DIRECT_RESULT');
});
