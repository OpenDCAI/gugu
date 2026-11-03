import { describe, expect, it } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-chat-ui';
import { timelineTurnsFromTranscript, ticksFromTurns } from '../../../../apps/desktop/src/session/renderer/features/sessions/view/session-timeline-turns';
import { renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';

const msg = (id: string, role: 'user' | 'assistant', text: string) =>
  ({ kind: 'message', id, seq: 0, role, text }) as TranscriptTurn['items'][number];
const turn = (id: string, initiator: 'user' | 'agent', items: TranscriptTurn['items']): TranscriptTurn => ({
  id,
  seq: 1,
  initiator,
  items,
});

describe('timelineTurnsFromTranscript (#4874 minimap ticks)', () => {
  it('one tick per committed user turn, anchored on the prompt, previewing the first reply', () => {
    const ticks = timelineTurnsFromTranscript([
      turn('t1', 'user', [
        msg('u1', 'user', '  first ask  '),
        msg('a1', 'assistant', 'first reply'),
        msg('a2', 'assistant', 'later'),
      ]),
      turn('t2', 'user', [msg('u2', 'user', 'second ask')]),
    ]);
    expect(ticks).toEqual([
      { id: 't1', anchorItemId: 'u1', itemIds: ['u1', 'a1', 'a2'], prompt: 'first ask', reply: 'first reply', mine: true },
      { id: 't2', anchorItemId: 'u2', itemIds: ['u2'], prompt: 'second ask', reply: '', mine: true },
    ]);
  });

  it('agent-initiated turns and prompt-less turns draw no tick', () => {
    expect(
      timelineTurnsFromTranscript([
        turn('bg', 'agent', [msg('a', 'assistant', 'background work')]),
        turn('empty', 'user', [msg('u', 'user', '   ')]),
      ])
    ).toEqual([]);
  });

  it("the user's own turns carry no sender", () => {
    const [tick] = timelineTurnsFromTranscript([turn('t', 'user', [msg('u', 'user', 'mine')])]);
    expect(tick.sender).toBeUndefined();
  });

  it('an empty transcript means no rail at all', () => {
    expect(timelineTurnsFromTranscript([])).toEqual([]);
  });
});

describe('#6006 input boundaries inside a provider turn', () => {
  it('keeps each input, its first following reply and a disjoint reading range', () => {
    const ticks = timelineTurnsFromTranscript([
      turn('t', 'user', [
        msg('u1', 'user', 'first'),
        msg('a1', 'assistant', 'first reply'),
        msg('u2', 'user', 'second'),
        msg('u3', 'user', 'third'),
        msg('a3', 'assistant', 'third reply'),
      ]),
    ]);
    expect(ticks).toEqual([
      { id: 't', anchorItemId: 'u1', itemIds: ['u1', 'a1'], prompt: 'first', reply: 'first reply', mine: true },
      { id: 't:u2', sourceTurnId: 't', anchorItemId: 'u2', itemIds: ['u2'], prompt: 'second', reply: '', mine: true },
      { id: 't:u3', sourceTurnId: 't', anchorItemId: 'u3', itemIds: ['u3', 'a3'], prompt: 'third', reply: 'third reply', mine: true },
    ]);
  });

  it('anchors the actual input when non-message items precede it', () => {
    const [tick] = timelineTurnsFromTranscript([
      turn('t', 'user', [msg('before', 'assistant', 'background'), msg('u', 'user', 'ask')]),
    ]);
    expect(tick.anchorItemId).toBe('u');
    expect(tick.reply).toBe('');
    expect(tick.itemIds).toEqual(['u']);
  });
});

// #6822 读方不借 DOM:投递轮在 node 里就判得到,退役的会话直发两行头也有发信人。
describe('human deliveries on the rail', () => {
  it('names a human sender and excludes retired agent session deliveries', () => {
    const origin = { source: 'session-direct', sender_session_id: 'session:parent', message_id: 'msg:m', kind: 'message' };
    const ticks = timelineTurnsFromTranscript([
      turn('t1', 'user', [msg('u1', 'user', '<gugu_delivery route="chat" from="Ada" from_id="user:ada" from_type="human" chat="7" chat_kind="group" source_link="gugu-chat://3f2a9c1e-0000-4000-8000-000000000007/5b0c0e1d-0000-4000-8000-000000000001"><![CDATA[看一下]]></gugu_delivery>')]),
      turn('t2', 'user', [msg('u2', 'user', `[gugu_session session-direct]\norigin=${JSON.stringify(origin)}\n派活`)]),
    ]);
    expect(ticks.map(({ prompt, sender }) => ({ prompt, sender }))).toEqual([
      { prompt: '看一下', sender: { kind: 'group', name: 'Ada', chatId: '3f2a9c1e-0000-4000-8000-000000000007' } },
    ]);
  });
});

describe('hidden input boundaries', () => {
  const agent = '<gugu_delivery route="chat" from="Worker" from_id="user:worker" from_type="agent"><![CDATA[agent input]]></gugu_delivery>';

  it('never attaches a hidden agent input or its reply to the preceding human preview', () => {
    const [human] = timelineTurnsFromTranscript([turn('t', 'user', [
      msg('u', 'user', 'Human question'), msg('hidden', 'user', agent),
      msg('hidden-answer', 'assistant', 'Agent-only reply'),
    ])]);
    expect(human.itemIds).toEqual(['u']);
    expect(human.reply).toBe('');
    expect(human.prompt).toBe('Human question');
  });

  it('preserves the actual anchor and source turn when the first input was hidden', () => {
    const humans = timelineTurnsFromTranscript([turn('t', 'user', [
      msg('hidden', 'user', agent), msg('hidden-answer', 'assistant', 'Agent-only reply'),
      msg('human', 'user', 'My follow-up'), msg('answer', 'assistant', '[NO_REPLY]'),
    ])]);
    expect(humans).toEqual([{
      id: 't:human', sourceTurnId: 't', anchorItemId: 'human', itemIds: ['human', 'answer'], prompt: 'My follow-up', reply: '', mine: true,
    }]);
  });
});

describe('UI-17 ownership and mixed ticks', () => {
  const delivery = (fromId: string) => renderDeliveryEnvelope({
    route: 'chat', from: 'Sender', fromId, fromType: 'human', messageId: 'msg:group',
    chat: '7', chatKind: 'group', content: 'Group question',
    sourceLink: 'gugu-chat://3f2a9c1e-0000-4000-8000-000000000007/5b0c0e1d-0000-4000-8000-000000000001',
  });
  const self = { userId: 'me', displayName: 'Me', guguNumber: null };

  it('marks direct input and own group messages as mine while retaining group preview provenance', () => {
    const turns = timelineTurnsFromTranscript([
      turn('direct', 'user', [msg('u1', 'user', 'Direct question')]),
      turn('own-group', 'user', [msg('u2', 'user', delivery('user:me'))]),
      turn('other', 'user', [msg('u3', 'user', delivery('user:other'))]),
    ], self);
    expect(turns.map(({ mine }) => mine)).toEqual([true, true, false]);
    expect(turns[1].sender).toEqual({ kind: 'group', name: 'Me', chatId: '3f2a9c1e-0000-4000-8000-000000000007' });
    expect(turns[2].sender?.kind).toBe('group');
  });

  it('uses the same signed-in ID fallback as shared human selection before a profile is available', () => {
    const [own] = timelineTurnsFromTranscript([
      turn('own-group', 'user', [msg('u', 'user', delivery('user:me'))]),
    ], null, { selfUserId: 'me' });
    expect(own.mine).toBe(true);
    expect(own.sender?.kind).toBe('group');
  });

  it('represents a mixed tick by its first own turn, while an all-other tick keeps its first turn', () => {
    const turns = timelineTurnsFromTranscript([
      turn('other-1', 'user', [msg('u1', 'user', delivery('user:other'))]),
      turn('mine', 'user', [msg('u2', 'user', 'My turn')]),
      turn('other-2', 'user', [msg('u3', 'user', delivery('user:other'))]),
      turn('other-3', 'user', [msg('u4', 'user', delivery('user:other'))]),
    ], self);
    expect(ticksFromTurns(turns, 2).map(({ mine, from, to, turn }) => ({ mine, from, to, anchor: turn.anchorItemId }))).toEqual([
      { mine: true, from: 1, to: 2, anchor: 'u2' },
      { mine: false, from: 3, to: 4, anchor: 'u3' },
    ]);
  });
});
