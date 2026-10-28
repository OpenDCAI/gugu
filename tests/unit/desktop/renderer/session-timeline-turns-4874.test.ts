import { describe, expect, it } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-chat-ui';
import { DELIVERY_RUN_MIN, ticksFromTurns, timelineTurnsFromTranscript, type TimelineTurn } from '../../../../apps/desktop/src/session/renderer/features/sessions/view/session-timeline-turns';

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
      turn('t1', 'user', [msg('u1', 'user', '<gugu_delivery route="chat" from="Ada" from_id="user:ada" chat="7" chat_kind="group" source_link="gugu-chat://3f2a9c1e-0000-4000-8000-000000000007/5b0c0e1d-0000-4000-8000-000000000001"><![CDATA[看一下]]></gugu_delivery>')]),
      turn('t2', 'user', [msg('u2', 'user', `[gugu_session session-direct]\norigin=${JSON.stringify(origin)}\n派活`)]),
    ]);
    expect(ticks.map(({ prompt, sender }) => ({ prompt, sender }))).toEqual([
      { prompt: '看一下', sender: { kind: 'group', name: 'Ada', chatId: '3f2a9c1e-0000-4000-8000-000000000007' } },
      { prompt: '派活', sender: { kind: 'session', name: 'session:parent' } },
    ]);
  });
});

describe('owner 2026-10-28: your turns stand out, runs of deliveries merge', () => {
  // m = your own turn, a/b = deliveries from two senders
  const seq = (pattern: string): TimelineTurn[] => [...pattern].map((c, i) => ({
    id: `t${i}`, anchorItemId: `u${i}`, itemIds: [`u${i}`], prompt: `p${i}`, reply: '',
    ...(c === 'm' ? {} : { sender: { kind: 'session' as const, name: c === 'a' ? 'Codex 3' : 'Claude 2' } }),
  }));
  const shape = (ticks: ReturnType<typeof ticksFromTurns>) => ticks.map((t) => `${t.mine ? 'M' : t.deliveries >= DELIVERY_RUN_MIN ? 'R' : 'd'}${t.from}-${t.to}`);

  it(`merges ${DELIVERY_RUN_MIN}+ consecutive deliveries into one tick; one or two stay one tick each`, () => {
    expect(DELIVERY_RUN_MIN).toBe(3);
    expect(shape(ticksFromTurns(seq('mamabmababam'), 0))).toEqual(['M1-1', 'd2-2', 'M3-3', 'd4-4', 'd5-5', 'M6-6', 'R7-11', 'M12-12']);
  });

  it('a merged run jumps to its first delivery and names each sender once, in order', () => {
    const run = ticksFromTurns(seq('mabaabm'), 0)[1]!;
    expect(run).toMatchObject({ from: 2, to: 6, mine: false, deliveries: 5 });
    expect(run.turn.anchorItemId).toBe('u1');
    expect(run.senders.map((s) => (s.kind === 'gugu' ? 'gugu' : s.name))).toEqual(['Codex 3', 'Claude 2']);
  });

  it('when one tick covers several segments, any turn of yours makes it yours (and it jumps to your turn)', () => {
    // 6 segments into 3 ticks: [a-run][m] [a][m] [b][b]  → stride 2
    const ticks = ticksFromTurns(seq('aaamambb'), 3);
    expect(shape(ticks)).toEqual(['M1-4', 'M5-6', 'd7-8']);
    expect(ticks[0]!).toMatchObject({ mine: true, deliveries: 3 });
    expect(ticks[0]!.turn.anchorItemId).toBe('u3');
  });

  it('every turn still belongs to exactly one tick', () => {
    const turns = seq('mabbbamaaaaaaambabm'.repeat(20));
    for (const capacity of [0, 7, 30, 1000]) {
      const ticks = ticksFromTurns(turns, capacity);
      expect(ticks[0]!.from).toBe(1);
      expect(ticks.at(-1)!.to).toBe(turns.length);
      for (let i = 1; i < ticks.length; i += 1) expect(ticks[i]!.from).toBe(ticks[i - 1]!.to + 1);
      if (capacity) expect(ticks.length).toBeLessThanOrEqual(capacity);
    }
  });

  it('what you sent it yourself from a chat counts as yours on the rail (still named, never mixed into a run)', () => {
    const env = (from: string, id: string, body: string) =>
      `<gugu_delivery route="chat" from="${from}" from_id="${id}" chat="7" chat_kind="group"><![CDATA[${body}]]></gugu_delivery>`;
    const self = { userId: 'owner-1', displayName: 'Owner', guguNumber: null };
    const turns = timelineTurnsFromTranscript([
      turn('t1', 'user', [msg('u1', 'user', env('Ada', 'user:ada', '一'))]),
      turn('t2', 'user', [msg('u2', 'user', env('Ada', 'user:ada', '二'))]),
      turn('t3', 'user', [msg('u3', 'user', env('Owner', 'user:owner-1', '我在群里说的'))]),
      turn('t4', 'user', [msg('u4', 'user', env('Ada', 'user:ada', '三'))]),
    ], self);
    expect(turns.map((t) => t.fromSelf ?? false)).toEqual([false, false, true, false]);
    // Without the self turn those four deliveries would be one merged run; with it, Ada's stay single ticks around yours.
    expect(shape(ticksFromTurns(turns, 0))).toEqual(['d1-1', 'd2-2', 'M3-3', 'd4-4']);
  });
});
