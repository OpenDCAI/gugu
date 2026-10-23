import { textFilePatch } from '../../lib/text-diff';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '../reducer/normalized-event';
import { decodeSessionUpdate } from './decode';

// The boundary retains canonical content and distinguishes absent fields from explicit null.
const fixtures: { name: string; update: unknown; event: NormalizedEvent }[] = [
  {
    name: 'user message without a native id retains its revert anchor',
    update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'edit this' }, _meta: { guguRevertAnchor: 'anchor' } },
    event: { kind: 'message', role: 'user', messageId: null, text: 'edit this', content: [{ type: 'text', text: 'edit this' }], contentMode: 'append', revertAnchor: 'anchor' },
  },
  {
    name: 'assistant message keeps the native id',
    update: { sessionUpdate: 'agent_message_chunk', messageId: 'answer', content: { type: 'text', text: 'done' } },
    event: { kind: 'message', role: 'assistant', messageId: 'answer', text: 'done', content: [{ type: 'text', text: 'done' }], contentMode: 'append' },
  },
  {
    name: 'thinking is separate from assistant text',
    update: { sessionUpdate: 'agent_thought_chunk', messageId: 'thought', content: { type: 'text', text: 'checking' } },
    event: { kind: 'thinking', messageId: 'thought', text: 'checking', content: [{ type: 'text', text: 'checking' }], contentMode: 'append' },
  },
  {
    name: 'an omitted tool title and locations remain an incomplete update',
    update: { sessionUpdate: 'tool_call_update', toolCallId: 'edit' },
    event: { kind: 'tool_update', toolCallId: 'edit' },
  },
  {
    name: 'an explicit null location collection stays null',
    update: { sessionUpdate: 'tool_call_update', toolCallId: 'edit', locations: null },
    event: { kind: 'tool_update', toolCallId: 'edit', locations: null },
  },
  {
    name: 'file preview, terminal reference and vendor tool name keep their identities',
    update: {
      sessionUpdate: 'tool_call', toolCallId: 'write', title: 'Write note', kind: 'edit', status: 'pending',
      content: [{ type: 'diff', path: '/note.txt', oldText: null, newText: 'one\n' }, { type: 'terminal', terminalId: 'terminal' }],
      _meta: { toolName: 'Write' },
    },
    event: {
      kind: 'tool_call', toolCallId: 'write', title: 'Write note', toolName: 'Write', toolKind: 'edit', status: 'pending',
      contentBlocks: [textFilePatch('/note.txt', null, 'one\n'), { type: 'terminal', terminalId: 'terminal' }], _meta: { toolName: 'Write' },
      parentToolCallId: null, locations: [], terminalId: 'terminal',
    },
  },
  {
    name: 'tool text, images and raw output stay distinct',
    update: {
      sessionUpdate: 'tool_call_update', toolCallId: 'browser', status: 'completed', rawOutput: { ok: true },
      content: [{ type: 'content', content: { type: 'text', text: '```text\nvisible\n```' } },
        { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'aW1n' } }],
    },
    event: {
      kind: 'tool_update', toolCallId: 'browser', status: 'completed', contentMode: 'replace',
      contentBlocks: [{ type: 'content', content: { type: 'text', text: '```text\nvisible\n```' } }, { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'aW1n' } }],
      outputText: 'visible', images: [{ mimeType: 'image/png', data: 'aW1n' }], rawOutput: '{\n  "ok": true\n}',
    },
  },
  {
    name: 'a native child idle cancels only that child',
    update: { sessionUpdate: 'subagent_update', sessionId: 'child', state: { state: 'idle', stopReason: 'cancelled' } },
    event: { kind: 'subagent_done', toolCallId: 'child', agentId: 'child', subagentSessionId: 'child', status: 'stopped' },
  },
  {
    name: 'the draft envelope is decoded before the tool-call branch',
    update: { sessionUpdate: 'tool_call_update', toolCallId: 'notice', _meta: { 'gugu.draftSessionUpdate': {
      sessionUpdate: 'notice', title: 'Background task stopped', description: 'Stopped by user',
    } } },
    event: { kind: 'session_notice', code: 'provider-notice', title: 'Background task stopped', detail: 'Stopped by user' },
  },
  {
    name: 'compaction keeps its own identity and summary',
    update: { sessionUpdate: 'compaction_update', compactionId: 'compact', status: 'completed', summary: [{ type: 'text', text: 'kept fact' }] },
    event: { kind: 'compaction', compactionId: 'compact', status: 'completed', summary: 'kept fact' },
  },
  {
    name: 'the current idle projection is unchanged, including its information limit',
    update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'error', error: { code: -32603, message: 'failed' } },
    event: { kind: 'agent_state', state: 'idle' },
  },
  {
    name: 'the current unknown-state projection is not silently upgraded during a move',
    update: { sessionUpdate: 'state_update', state: 'unknown' },
    event: { kind: 'ignored' },
  },
];

for (const sessionUpdate of ['async_task_spawned', '_async_task_spawned']) {
  fixtures.push({
    name: `${sessionUpdate} keeps the same background task without foreground coupling`,
    update: { sessionUpdate, asyncTaskId: 'background', name: 'Compile', taskType: 'Bash', canStop: true, toolCallId: 'launch' },
    event: { kind: 'async_task', asyncTaskId: 'background', name: 'Compile', taskType: 'Bash', description: '', showInTranscript: false, canStop: true, toolCallId: 'launch' },
  });
}

describe('transport boundary decodes domain entities', () => {
  it.each(fixtures)('$name', ({ update, event }) => {
    expect(decodeSessionUpdate(update as SessionUpdate)).toStrictEqual(event);
  });
});
