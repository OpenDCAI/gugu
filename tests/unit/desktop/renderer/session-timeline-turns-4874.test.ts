import { describe, expect, it } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-chat-ui';
import { timelineTurnsFromTranscript } from '../../../../apps/desktop/src/session/renderer/features/sessions/view/session-timeline-turns';

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
      { id: 't1', anchorItemId: 'u1', itemIds: ['u1', 'a1', 'a2'], prompt: 'first ask', reply: 'first reply' },
      { id: 't2', anchorItemId: 'u2', itemIds: ['u2'], prompt: 'second ask', reply: '' },
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
      { id: 't', anchorItemId: 'u1', itemIds: ['u1', 'a1'], prompt: 'first', reply: 'first reply' },
      { id: 't:u2', sourceTurnId: 't', anchorItemId: 'u2', itemIds: ['u2'], prompt: 'second', reply: '' },
      { id: 't:u3', sourceTurnId: 't', anchorItemId: 'u3', itemIds: ['u3', 'a3'], prompt: 'third', reply: 'third reply' },
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
describe('delivered turns (#6822)', () => {
  it('previews the body and names the sender of every delivery spelling', () => {
    const origin = { source: 'session-direct', sender_session_id: 'session:parent', message_id: 'msg:m', kind: 'message' };
    const ticks = timelineTurnsFromTranscript([
      turn('t1', 'user', [msg('u1', 'user', '<gugu_delivery route="chat" from="Ada" from_id="user:ada" chat="7" chat_kind="group"><![CDATA[看一下]]></gugu_delivery>')]),
      turn('t2', 'user', [msg('u2', 'user', `[gugu_session session-direct]\norigin=${JSON.stringify(origin)}\n派活`)]),
    ]);
    expect(ticks.map(({ prompt, sender }) => ({ prompt, sender }))).toEqual([
      { prompt: '看一下', sender: { kind: 'group', name: 'Ada', chat: '7' } },
      { prompt: '派活', sender: { kind: 'session', name: 'session:parent' } },
    ]);
  });
});
