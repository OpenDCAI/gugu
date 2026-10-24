import { AcpTranscriptParser } from '@gugu/session-core/acp/transcript-parser';
import { expect, it } from 'vitest';
import { createClaudeSessionDecoder } from './claude/acp-transform';

const decodeClaudeSessionUpdate = createClaudeSessionDecoder();

it('#6020 genuine Claude launch/result payloads survive sparse updates and domain replay', () => {
  const input = { description: 'Inspect files', prompt: 'FULL_PROMPT', model: 'requested-model' };
  const meta = { claudeCode: { toolName: 'Agent' } };
  const events = [
    { sessionUpdate: 'tool_call', toolCallId: 'delegate', title: 'Inspect files', kind: 'other', status: 'in_progress', rawInput: input, _meta: meta },
    { sessionUpdate: 'tool_call_update', toolCallId: 'delegate', title: 'Inspect files', rawInput: input,
      rawOutput: { message: 'DIRECT_RESULT', details: ['complete'] },
      content: [{ type: 'content', content: { type: 'text', text: 'DIRECT_RESULT' } }], _meta: meta },
    { sessionUpdate: 'tool_call_update', toolCallId: 'delegate', status: 'completed', name: 'Agent' },
  ].map(raw => decodeClaudeSessionUpdate(raw as never));
  const parser = new AcpTranscriptParser({ sessionId: 'claude' });
  for (const event of events) parser.pushEvent(event);
  expect(parser.activeTurn?.items.find(node => 'toolCallId' in node && node.toolCallId === 'delegate'))
    .toMatchObject({ kind: 'spawn-subagent-tool-call', status: 'done', model: 'requested-model',
      rawInput: JSON.stringify(input, null, 2),
      rawOutput: JSON.stringify({ message: 'DIRECT_RESULT', details: ['complete'] }, null, 2), outputText: 'DIRECT_RESULT' });
  const replay = AcpTranscriptParser.replay(events, { sessionId: 'claude' });
  expect(JSON.stringify(replay.committed)).toContain('FULL_PROMPT');
  expect(JSON.stringify(replay.committed)).toContain('DIRECT_RESULT');
});
