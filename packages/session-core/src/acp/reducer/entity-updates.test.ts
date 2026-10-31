import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { decodeSessionUpdate } from '../transport/decode';
import { AcpTranscriptParser } from './parser';

function fixture() {
  const parser = new AcpTranscriptParser({ sessionId: 'entities' });
  let at = 100;
  const send = (update: Record<string, unknown>) => parser.pushEvent(decodeSessionUpdate(update as SessionUpdate), at++);
  const items = () => [...parser.history.flatMap(turn => turn.items), ...(parser.activeTurn?.items ?? [])];
  return { parser, send, items };
}

describe('entity replacement at the transport boundary', () => {
  it('replaces, appends, shortens and clears a message without changing its identity or order', () => {
    const { send, items } = fixture();
    send({ sessionUpdate: 'agent_message', messageId: 'm', content: [{ type: 'text', text: 'long answer' }] });
    const first = items()[0];
    send({ sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: ' tail' } });
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({ text: 'long answer tail', id: first.id, seq: first.seq });
    send({ sessionUpdate: 'agent_message', messageId: 'm', content: [{ type: 'text', text: 'short' }] });
    expect(items()[0]).toMatchObject({ text: 'short', id: first.id, seq: first.seq });
    send({ sessionUpdate: 'agent_message', messageId: 'm', content: [] });
    expect(items()[0]).toMatchObject({ text: '', id: first.id });
    send({ sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: 'new' } });
    expect(items()[0]).toMatchObject({ text: 'new' });
    send({ sessionUpdate: 'agent_message', messageId: 'm', content: null });
    expect(items()[0]).toMatchObject({ text: '' });
  });

  it('keeps non-text blocks and patches metadata by top-level key, without appending text on metadata-only updates', () => {
    const { send, items } = fixture();
    const picture = { type: 'image', mimeType: 'image/png', data: 'fixture-image' };
    send({ sessionUpdate: 'agent_message', messageId: 'm', content: [{ type: 'text', text: 'caption' }, picture], _meta: { stable: 1, nested: { before: true } } });
    send({ sessionUpdate: 'agent_message', messageId: 'm', _meta: { nested: { after: true } } });
    expect(items()[0]).toMatchObject({ text: 'caption', content: [{ type: 'text', text: 'caption' }, picture], _meta: { stable: 1, nested: { after: true } } });
    expect(items()[0]).not.toHaveProperty('_meta.nested.before');
    send({ sessionUpdate: 'agent_message', messageId: 'm', _meta: null });
    expect(items()[0]).not.toHaveProperty('_meta');
    expect(items()[0]).toMatchObject({ text: 'caption' });
  });

  it('updates a committed message in its owning turn, even while a later turn is active', () => {
    const { parser, send, items } = fixture();
    send({ sessionUpdate: 'agent_message', messageId: 'old', content: [{ type: 'text', text: 'old answer' }] });
    parser.endTurn(110);
    const owner = parser.history[0];
    send({ sessionUpdate: 'user_message_chunk', messageId: 'new-user', content: { type: 'text', text: 'next input' } });
    const active = parser.activeTurn;
    send({ sessionUpdate: 'agent_message', messageId: 'old', content: [{ type: 'text', text: 'corrected' }] });
    expect(parser.history[0]).toMatchObject({ id: owner.id, items: [{ text: 'corrected' }] });
    expect(parser.history[0].outcome).toEqual(owner.outcome);
    expect(parser.activeTurn).toEqual(active);
    expect(items().filter(item => item.kind === 'message')).toHaveLength(2);
  });

  it('replaces completed thought content instead of creating another thinking segment', () => {
    const { parser, send, items } = fixture();
    send({ sessionUpdate: 'agent_thought_chunk', messageId: 't', content: { type: 'text', text: 'draft' } });
    send({ sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: 'answer' } });
    send({ sessionUpdate: 'agent_thought', messageId: 't', content: [{ type: 'text', text: 'revised' }] });
    expect(items().filter(item => item.kind === 'thinking')).toHaveLength(1);
    expect(items()[0]).toMatchObject({ text: 'revised', status: 'done' });
    expect(parser.activeTurn?.items[1]).toMatchObject({ text: 'answer' });
  });

  it('retains an early tool result when name, kind and input arrive later', () => {
    const { send, items } = fixture();
    send({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'result' } }] });
    const id = items()[0].id;
    send({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', name: 'Bash', title: 'List files', kind: 'execute', rawInput: { command: 'ls' } });
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({ id, kind: 'execute-tool-call', title: 'List files', toolName: 'Bash', outputText: 'result', status: 'done' });
  });

  it('distinguishes absent, null and empty tool fields and content chunks', () => {
    const { send, items } = fixture();
    send({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', name: 'Read', title: 'Read file', kind: 'read', locations: [{ path: '/a' }], rawInput: { path: '/a' }, rawOutput: { size: 1 }, content: [{ type: 'content', content: { type: 'text', text: 'old' } }], _meta: { keep: true, nested: { old: true } } });
    send({ sessionUpdate: 'tool_call_content_chunk', toolCallId: 'tool', content: { type: 'content', content: { type: 'text', text: 'tail' } } });
    expect(items()[0]).toMatchObject({ outputText: 'old\ntail', toolName: 'Read', path: '/a' });
    send({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed', _meta: { nested: { next: true } } });
    expect(items()[0]).toMatchObject({ outputText: 'old\ntail', toolName: 'Read', _meta: { keep: true, nested: { next: true } } });
    send({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', name: null, title: null, locations: null, rawInput: null, rawOutput: null, content: [], _meta: null });
    const last = items()[0];
    for (const key of ['toolName', 'rawInput', 'rawOutput', 'outputText', 'images', 'path', '_meta']) expect(last).not.toHaveProperty(key);
    expect(last).toMatchObject({ title: '', status: 'done' });
    send({ sessionUpdate: 'tool_call_content_chunk', toolCallId: 'tool', content: { type: 'content', content: { type: 'text', text: 'fresh' } } });
    expect(items()[0]).toMatchObject({ outputText: 'fresh' });
    send({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', content: null });
    expect(items()[0]).not.toHaveProperty('outputText');
  });

  it('replaces raw payloads with empty strings and clears all projections of replaced tool content', () => {
    const { send, items } = fixture();
    send({ sessionUpdate: 'tool_call_update', toolCallId: 't', kind: 'execute', rawInput: 'old input', rawOutput: 'old output', content: [
      { type: 'terminal', terminalId: 'terminal' },
      { type: 'content', content: { type: 'text', text: 'old output' } },
      { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'fixture-image' } },
    ] });
    expect(items()[0]).toMatchObject({ terminalId: 'terminal', outputText: 'old output', images: [{ data: 'fixture-image' }] });
    send({ sessionUpdate: 'tool_call_update', toolCallId: 't', rawInput: '', rawOutput: '', content: [] });
    expect(items()[0]).toMatchObject({ rawInput: '', rawOutput: '', contentBlocks: [] });
    for (const key of ['terminalId', 'outputText', 'images']) expect(items()[0]).not.toHaveProperty(key);
    send({ sessionUpdate: 'tool_call_content_chunk', toolCallId: 't', content: { type: 'terminal', terminalId: 'next-terminal' } });
    expect(items()[0]).toMatchObject({ terminalId: 'next-terminal' });
  });

  it('applies a late tool patch to its committed owner instead of making a second card', () => {
    const { parser, send, items } = fixture();
    send({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', title: 'before', content: [{ type: 'content', content: { type: 'text', text: 'before' } }] });
    parser.endTurn(110);
    send({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', title: 'after', content: [{ type: 'content', content: { type: 'text', text: 'after' } }] });
    expect(parser.activeTurn).toBeNull();
    expect(parser.history).toHaveLength(1);
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({ title: 'after', outputText: 'after' });
  });

  it('removes null metadata keys, ignores chunk-scoped metadata and clears reported tool status', () => {
    const { send, items } = fixture();
    send({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed', _meta: { keep: 1, drop: 2 } });
    send({ sessionUpdate: 'tool_call_content_chunk', toolCallId: 't', content: { type: 'content', content: { type: 'text', text: 'body' } }, _meta: { keep: 99 } });
    send({ sessionUpdate: 'tool_call_update', toolCallId: 't', _meta: { drop: null } });
    expect(items()[0]).toMatchObject({ status: 'done', _meta: { keep: 1 } });
    expect(items()[0]).not.toHaveProperty('_meta.drop');
    send({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: null });
    expect(items()[0]).toMatchObject({ status: 'unknown' });
  });

  it('retains all plan forms by id and removes only the specified plan and its markers', () => {
    const { parser, send, items } = fixture();
    send({ sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'a', entries: [{ content: 'one', status: 'pending', priority: 'high' }] } });
    send({ sessionUpdate: 'plan_update', plan: { type: 'markdown', planId: 'b', content: '# Proposal', _meta: { native: true } } });
    expect(parser.plan).toMatchObject({ a: { entries: [{ content: 'one' }] }, b: { body: { type: 'markdown', content: '# Proposal', _meta: { native: true } } } });
    expect(items()).toHaveLength(2);
    parser.endTurn(110);
    send({ sessionUpdate: 'plan_update', plan: { type: 'file', planId: 'b', uri: 'file:///work/plan.md' } });
    expect(parser.activeTurn).toBeNull();
    expect(parser.plan?.b).toMatchObject({ body: { type: 'file', uri: 'file:///work/plan.md' } });
    send({ sessionUpdate: 'plan_removed', planId: 'missing' });
    expect(Object.keys(parser.plan ?? {})).toEqual(['a', 'b']);
    send({ sessionUpdate: 'plan_removed', planId: 'a' });
    expect(Object.keys(parser.plan ?? {})).toEqual(['b']);
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({ planId: 'b' });
    send({ sessionUpdate: 'plan_removed', planId: 'b' });
    expect(parser.plan).toBeNull();
    expect(items()).toEqual([]);
  });

  it('continues replacement and chunks after a serialized snapshot has been restored', () => {
    const { parser, send } = fixture();
    send({ sessionUpdate: 'agent_message', messageId: 'm', content: [{ type: 'text', text: 'long original' }] });
    send({ sessionUpdate: 'tool_call_update', toolCallId: 't', title: 'original', content: [{ type: 'content', content: { type: 'text', text: 'original' } }] });
    parser.endTurn(110);
    const restored = new AcpTranscriptParser({ sessionId: 'entities' });
    restored.restoreState(JSON.parse(JSON.stringify(parser.snapshotState())));
    for (const target of [parser, restored]) {
      target.pushEvent(decodeSessionUpdate({ sessionUpdate: 'agent_message', messageId: 'm', content: [] } as never), 111);
      target.pushEvent(decodeSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't', content: null } as never), 112);
      target.pushEvent(decodeSessionUpdate({ sessionUpdate: 'tool_call_content_chunk', toolCallId: 't', content: { type: 'content', content: { type: 'text', text: 'new' } } } as never), 113);
    }
    expect(restored.snapshotState()).toEqual(parser.snapshotState());
    expect(restored.activeTurn).toBeNull();
    expect(restored.history[0].items).toMatchObject([{ text: '' }, { outputText: 'new' }]);
  });
});
