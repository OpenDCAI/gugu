import { describe, expect, it } from 'vitest';
import { renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { unit } from '@session-chat/core/units';
import type { ItemSegmenter, SegmentCtx, SegmentItem } from '@session-chat/core/units';
import { defaultChatTranslator } from '@session-chat/localization';
import type { AgentSendItem, ChatItem, ChatMessage, TranscriptTurn } from '@session-chat/model';
import { agentSendLabel } from './agent-send';
import { flattenTier } from './flatten';
import { toolRunCategory } from './tool-run';

const CHAT = '127ec4f0-30b1-4583-b469-706756153bdd';
const SOURCE = '6417511d-8f36-4cbc-8cbb-81ce9f97df73';

const passthrough = new Proxy({} as Record<string, ItemSegmenter>, {
  get: (_t, kind: string) => ({ kind, segment: (item: SegmentItem) => [unit(item.kind, item, item, { key: 'self' })] }),
});
const ctx = (extra: Partial<SegmentCtx> = {}): SegmentCtx =>
  ({
    caches: {},
    expanded: () => false,
    active: false,
    plan: () => null,
    translate: defaultChatTranslator,
    pendingToolCallIds: () => new Set<string>(),
    terminalOutputText: () => null,
    terminalExitStatus: () => null,
    foldTurnProcess: true,
    ...extra,
  }) as unknown as SegmentCtx;

const input = (thread?: string): ChatItem => ({
  kind: 'message', id: 'input', seq: 0, role: 'user',
  text: renderDeliveryEnvelope({ route: 'chat', from: 'Owner', fromId: 'user:owner', chat: '216012', chatKind: 'group',
    sourceLink: `gugu-chat://${CHAT}/${SOURCE}`, messageId: `msg:${SOURCE}`, content: 'Go', at: '2026-10-27T04:10:00Z',
    ...(thread ? { thread } : {}) }),
} as ChatItem);
const bash = (id: string): ChatItem =>
  ({ kind: 'execute-tool-call', id, seq: 0, toolCallId: id, title: 'sleep 10', command: 'sleep 10', status: 'done' }) as unknown as ChatItem;
const send = (id: string, text: string, status: 'running' | 'done' = 'done'): ChatItem =>
  ({ kind: 'mcp-tool-call', id, seq: 0, toolCallId: id, title: 'message_send', tool: 'message_send', server: 'plugin_gugu-product_gugu',
    status, rawInput: JSON.stringify({ chat_id: '216012', text }) }) as unknown as ChatItem;
const turn = (items: ChatItem[], done = true): TranscriptTurn =>
  ({ id: 't', seq: 1, initiator: 'user', items, ...(done ? { outcome: { kind: 'done' } } : {}) }) as unknown as TranscriptTurn;

const sends = (units: ReturnType<typeof flattenTier>) =>
  units.filter((u) => u.kind === 'agent-send').map((u) => (u.data as AgentSendItem).send.text);

describe('agent-send: what the agent said through 咕咕 shows as its words', () => {
  it('names where it went — the group, a topic in it, a whisper, another task', () => {
    const named = (id: string) => (id === CHAT ? 'gugu' : null);
    const chat = { kind: 'chat' as const, conversationId: CHAT, threadRootId: null, whisper: false };
    expect(agentSendLabel(chat, defaultChatTranslator, named)).toBe('Sent to gugu');
    expect(agentSendLabel({ ...chat, threadRootId: 'msg:root' }, defaultChatTranslator, named)).toBe('Sent to a topic in gugu');
    // The host does not know that group: say so without the number.
    expect(agentSendLabel({ ...chat, threadRootId: 'msg:root' }, defaultChatTranslator, () => null)).toBe('Sent to a topic');
    expect(agentSendLabel({ ...chat, conversationId: null }, defaultChatTranslator, named)).toBe('Sent · destination name unavailable');
    expect(agentSendLabel({ ...chat, whisper: true }, defaultChatTranslator, named)).toBe('Whispered in gugu');
    expect(agentSendLabel({ kind: 'session', count: 1 }, defaultChatTranslator, named)).toBe('Sent to another task');
    expect(agentSendLabel({ kind: 'session', count: 3 }, defaultChatTranslator, named)).toBe('Sent to 3 tasks');
  });

  it('is not counted into "called N MCP tools": it splits the run like text does', () => {
    expect(toolRunCategory(send('s', 'hi'))).toBeNull();
    expect(toolRunCategory({ ...send('s', 'hi'), status: 'error' } as ChatItem)).toBe('mcp');
  });

  it('while the turn runs, every round\'s words are on screen between the commands, with the thread they went to', () => {
    const live = turn([input('msg:root'), bash('b1'), send('s1', 'Round 1'), bash('b2'), send('s2', 'Round 2', 'running')], false);
    const units = flattenTier([live], ctx({ active: true }), passthrough);
    expect(sends(units)).toEqual(['Round 1', 'Round 2']);
    const second = units.find((u) => u.kind === 'agent-send' && (u.data as AgentSendItem).id === 's2')?.data as AgentSendItem;
    expect(second).toMatchObject({ status: 'running', send: { to: { conversationId: CHAT, threadRootId: 'msg:root' } } });
    expect(units.some((u) => u.kind === 'tool-run')).toBe(false);
  });

  it('after the turn, the last send stays outside the fold like a last reply; earlier ones fold with the work', () => {
    const units = flattenTier([turn([input(), bash('b1'), send('s1', 'Round 1'), bash('b2'), send('s2', 'Done: all 10 steps')])], ctx(), passthrough);
    expect(units.map((u) => u.kind)).toEqual(['message', 'turn-process', 'agent-send']);
    expect(sends(units)).toEqual(['Done: all 10 steps']);
  });
});

describe('agent-send: a send that went through is drawn once, not again as the reply copied out of it (#638)', () => {
  // A real successful send carries its message id; `withSentReplies` copies that into a reply. Fixtures above have no
  // output, so they never met the copy.
  const delivered = { ...(send('s1', 'HELLO-ONCE') as object), outputText: 'sent (id=msg:7417511d-8f36-4cbc-8cbb-81ce9f97df73)' } as unknown as ChatItem;
  const drawn = (units: ReturnType<typeof flattenTier>) => units.flatMap((u) => {
    if (u.kind === 'agent-send' && (u.data as AgentSendItem).send.text === 'HELLO-ONCE') return ['agent-send'];
    if (u.kind === 'message' && (u.data as { text?: string }).text === 'HELLO-ONCE') return ['message'];
    return [];
  });
  const views = [['session page', false, 'agent-send'], ['agent conversation', true, 'message']] as const;
  const states = [
    ['running', { active: true }, false],
    ['done, process open', { foldTurnProcess: false }, true],
    ['done, folded', {}, true],
  ] as const;
  for (const [view, agentConversation, as] of views) for (const [state, extra, done] of states) {
    it(`${view}, ${state}: once, as ${as}`, () => {
      const units = flattenTier([turn([input(), delivered], done)], ctx({ agentConversation, ...extra } as Partial<SegmentCtx>), passthrough);
      expect(drawn(units)).toEqual([as]);
    });

    it(`${view}, ${state}: a background turn names the send's own destination without a delivery`, () => {
      const record = { ...turn([delivered], done), initiator: 'agent' as const };
      const units = flattenTier([record], ctx({ agentConversation, ...extra } as Partial<SegmentCtx>), passthrough);
      expect(drawn(units)).toEqual([as]);
      const output = units.find(u => u.kind === as && (as === 'agent-send'
        ? (u.data as AgentSendItem).send.text : (u.data as ChatMessage).text) === 'HELLO-ONCE')!.data as AgentSendItem | ChatMessage;
      const destination = output.kind === 'agent-send' ? output.send.to : (output as ChatMessage).sentTo;
      expect(destination).toBeDefined();
      expect(agentSendLabel(destination!, defaultChatTranslator, id => id === '216012' ? 'Design review' : null)).toBe('Sent to Design review');
      expect(agentSendLabel(destination!, defaultChatTranslator, () => null)).toBe('Sent · destination name unavailable');
      expect(output).not.toHaveProperty('conversationReply');
    });
  }
});
