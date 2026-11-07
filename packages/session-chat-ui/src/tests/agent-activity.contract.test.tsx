/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cdp, page } from 'vitest/browser';
import { batch } from 'solid-js';
import { textFilePatch } from '@gugu/session-core/lib';
import type { ChatItem } from '../model';
import { createChatContext } from '../chat-context';
import { createChatState } from '../state/chat-state';
import { createChatView } from '../chat-view';
import type { ChatMessage, TranscriptTurn } from '../model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';
import { pinFade } from '../chat-root.css';

const peer = 'user:11111111-1111-4111-8111-111111111111';
const me = '22222222-2222-4222-8222-222222222222';
const delivery = (id: string, body = 'Agent update', type = 'agent') => ({ kind: 'message' as const, id, seq: 0, role: 'user' as const, text:
  `<gugu_delivery route="chat" from="d3" from_id="${type === 'agent' ? peer : `user:${me}`}" from_type="${type}" chat="group" chat_kind="group" msg="msg:${id}"><![CDATA[${body}]]></gugu_delivery>` });
const ordinary = (id: string, role: 'user' | 'assistant' = 'assistant'): ChatMessage => ({ kind: 'message', id, seq: 0, role, text: id });
const turn = (id: string, items: ChatMessage[]): TranscriptTurn => ({ id, seq: 0, initiator: 'user', outcome: { kind: 'done' }, items: items as TranscriptTurn['items'] });
const cleanup: Array<() => void> = [];
afterEach(async () => { while (cleanup.length) cleanup.pop()?.(); await cdp().send('Emulation.setEmulatedMedia', { features: [] }); });

async function mount(width: number, records = [turn('in', [delivery('incoming')]), turn('panel', [ordinary('Panel answer')])]) {
  await page.viewport(Math.max(width, 390), 720);
  const context = createChatContext({ locale: () => 'en-US', layout: { preset: 'double', agentConversation: true, userGutter: 0 },
    actor: id => id === peer ? { id, type: 'agent', name: 'd3' } : null,
    selfIdentity: () => ({ userId: me, displayName: 'Owner', guguNumber: null }), chatName: () => 'gugu', chatKind: () => 'group' });
  const state = createChatState(context);
  state.transcript.history.seed(records);
  const host = document.body.appendChild(document.createElement('div'));
  host.style.cssText = `position:fixed;top:0;left:0;width:${width}px;height:600px`;
  const open = vi.fn();
  const create = () => createChatView({ context, state, parent: host, pinUserMessages: true, commands: { onOpenSender: open } });
  let view = create();
  view.scrollToTop();
  cleanup.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  const head = () => host.querySelector<HTMLElement>('[data-agent-activity]');
  const button = () => head()!.querySelector<HTMLButtonElement>('[data-collapse-id]')!;
  await until('activity header mounted', () => !!head());
  await untilStable('initial geometry settled', () => [host.querySelector('[data-chat-canvas]')?.getBoundingClientRect().height]);
  return { host, state, head, button, open, get view() { return view; },
    remount: () => { view.dispose(); view = create(); }, scroll: () => host.querySelector<HTMLElement>('[data-chat-scroll]')! };
}

describe('approved A2A activity', () => {
  it('folds the producing activity with its edited file and preview, then restores both on open', async () => {
    const items: ChatItem[] = [delivery('with-file'),
      { kind: 'diff', id: 'owned-edit', status: 'done', patches: [textFilePatch('/work/owned.md', null, 'ready')] },
      { kind: 'mcp-tool-call', id: 'owned-preview', seq: 2, toolCallId: 'owned-preview', title: 'Open preview', server: 'gugu', tool: 'session_open_in_tab',
        status: 'done', rawInput: '{"path":"/work/preview.html"}', outputText: '{"opened":true,"path":"/work/preview.html"}' }];
    const records = [{ ...turn('with-file', []), items: items as TranscriptTurn['items'] }, turn('after-file', [delivery('after-file')])];
    const t = await mount(390, records);
    expect(t.host.querySelectorAll('[data-agent-activity]')).toHaveLength(1);
    expect(t.host.querySelector('[data-slot="file-change-summary"]')).toBeNull();
    expect(t.host.textContent).not.toContain('preview.html');
    t.button().click();
    await until('owned artifacts open inside the original activity', () => !!t.host.querySelector('[data-slot="file-change-summary"]') && !!t.host.textContent?.includes('preview.html'));
    expect(t.host.querySelectorAll('[data-agent-activity]')).toHaveLength(1);
    expect(t.host.textContent).toContain('owned.md');
    t.button().click();
    await until('owned artifacts collapse again', () => !t.host.querySelector('[data-slot="file-change-summary"]'));
    expect(t.host.textContent).not.toContain('preview.html');
    expect(t.head()!.textContent).toContain('Received 2 messages');
  });
  it('combines tool-only incoming turns while preserving their original process on open', async () => {
    const records = ['one', 'two'].map((id, seq): TranscriptTurn => ({ ...turn(id, [delivery(`${id}-input`)]), seq, items: [delivery(`${id}-input`),
      { kind: 'mcp-tool-call', id: `${id}-read`, toolCallId: `${id}-read`, seq: 1, title: 'Read history', server: 'gugu', tool: 'message_history', status: 'done', rawInput: '{"chat_id":"group"}', outputText: '[]' }] }));
    const t = await mount(800, records);
    expect(t.host.querySelectorAll('[data-agent-activity]')).toHaveLength(1);
    expect(t.head()!.textContent).toContain('Received 2 messages');
    const before = t.scroll().scrollHeight;
    t.button().click();
    await until('both original inputs are visible', () => !!t.host.querySelector('[data-user-card="one-input"]') && !!t.host.querySelector('[data-user-card="two-input"]'));
    expect(t.host.querySelectorAll('[data-slot="turn-process"]')).toHaveLength(2);
    t.button().click();
    await untilStable('one activity shrinks back', () => t.scroll().scrollHeight);
    expect(t.scroll().scrollHeight).toBe(before);
  });

  it('never pins an activity header that has not been expanded, or has been collapsed again', async () => {
    const records = [turn('own', [ordinary('Owner question', 'user')]), turn('incoming', [delivery('incoming')]),
      ...Array.from({ length: 15 }, (_, i) => turn(`later${i}`, [ordinary(`Visible answer ${i}. `.repeat(35))]))];
    const t = await mount(800, records);
    const sticky = () => getComputedStyle(t.head()!.closest('[data-index]')!.firstElementChild!).position;
    expect(sticky()).not.toBe('sticky');
    const lane = () => t.head()!.closest<HTMLElement>('[data-index]')!;
    for (const scrollTop of [80, 130, 180]) {
      t.scroll().scrollTop = scrollTop;
      await untilStable('closed row scrolling near the top', () => t.head()?.getBoundingClientRect().top);
      expect(lane().querySelector('[data-chat-pin-backdrop]'), 'closed activity never paints the sticky divider').toBeNull();
    }
    t.view.scrollToTop();
    t.button().click();
    await until('opened activity is sticky eligible', () => sticky() === 'sticky');
    t.button().click();
    await untilStable('reclosed activity settled', () => t.scroll().scrollHeight);
    expect(sticky()).not.toBe('sticky');
    expect(lane().querySelector('[data-chat-pin-backdrop]')).toBeNull();
  });
  it('keeps the owner pinned while reading ordinary reply content beside a closed activity', async () => {
    const t = await mount(800, [turn('own', [ordinary('Owner question', 'user'), delivery('incoming'),
      ...Array.from({ length: 24 }, (_, i) => ordinary(`Reply ${i}. `.repeat(45)))]),
      turn('next', [ordinary('Next owner question', 'user'), ordinary('Next answer')])]);
    expect(t.button().getAttribute('aria-expanded')).toBe('false');
    t.scroll().scrollTop = 850;
    await untilStable('owner reading ordinary reply', () => t.host.querySelector('[data-agent-conversation-message="Owner question"]')?.getBoundingClientRect().top);
    const row = t.host.querySelector<HTMLElement>('[data-agent-conversation-message="Owner question"]');
    expect(row).not.toBeNull();
    expect(row!.getBoundingClientRect().top).toBeCloseTo(t.scroll().getBoundingClientRect().top + 8, 0);
  });
  it('pins the viewer human delivery above its opened activity without treating other human deliveries as the viewer', async () => {
    const own = delivery('Owner message', 'The question I sent from the phone', 'human');
    const t = await mount(800, [turn('own', [own, ...Array.from({ length: 24 }, (_, i) => delivery(`a${i}`, `Update ${i}. `.repeat(45)))]),
      turn('conclusion', [ordinary('Following conclusion')])]);
    t.button().click();
    await untilStable('human owner activity geometry', () => t.scroll().scrollHeight);
    t.scroll().scrollTop = 850;
    await untilStable('human owner sticky position', () => t.host.querySelector('[data-agent-conversation-message="Owner message"]')?.getBoundingClientRect().top);
    const row = t.host.querySelector<HTMLElement>('[data-agent-conversation-message="Owner message"]');
    expect(row, 'the viewer message must remain mounted while its activity is read').not.toBeNull();
    expect(row!.getBoundingClientRect().top).toBeCloseTo(t.scroll().getBoundingClientRect().top + 8, 0);
  });

  it.each([390, 1280])('defaults closed with centered 44px semantic action and original bubbles on manual open (%i)', async width => {
    const t = await mount(width);
    expect(t.head()!.textContent).toContain('Received 1 message from d3');
    expect(t.button().getAttribute('aria-expanded')).toBe('false');
    expect(t.host.querySelector('[data-agent-conversation-message="incoming"]')).toBeNull();
    const row = t.head()!.getBoundingClientRect();
    expect(row.height).toBe(44);
    const inline = t.head()!.lastElementChild!.getBoundingClientRect();
    expect(Math.abs((inline.left + inline.right) / 2 - (row.left + row.right) / 2)).toBeLessThan(1);
    t.button().click();
    await until('original agent input visible', () => !!t.host.querySelector('[data-agent-conversation-message="incoming"]'));
    await untilStable('expanded height settled', () => t.scroll().scrollHeight);
    expect(t.button().getAttribute('aria-expanded')).toBe('true');
    expect(t.host.querySelector('[data-user-card="incoming"]')?.textContent).toContain('Agent update');
    t.button().click();
    await until('original bubble removed after shrink', () => !t.host.querySelector('[data-agent-conversation-message="incoming"]'));
    expect(t.host.querySelector('[data-agent-conversation-message="Panel answer"]')).not.toBeNull();
  });
  it('navigates an agent name independently of expanding the record', async () => {
    const t = await mount(800);
    t.head()!.querySelector<HTMLButtonElement>('[data-activity-target]')!.click();
    expect(t.open).toHaveBeenCalledWith({ kind: 'sender', userId: peer.slice(5) });
    expect(t.button().getAttribute('aria-expanded')).toBe('false');
  });
  it('opens the owning activity and positions the original message for a search-result jump', async () => {
    const records = Array.from({ length: 18 }, (_, i) => turn(`search${i}`, [delivery(`search${i}`, `Search result ${i}. `.repeat(50))]));
    const t = await mount(390, [...records, turn('answer', [ordinary('Search ending')])]);
    expect(t.button().getAttribute('aria-expanded')).toBe('false');
    t.view.scrollToItem('search12', { align: 'center' });
    await until('search opens the owning activity', () => t.head()?.dataset.expanded === 'true');
    await untilStable('original search result positioned', () => {
      const row = t.host.querySelector('[data-agent-conversation-message="search12"]');
      return row?.getBoundingClientRect().top;
    });
    const row = t.host.querySelector('[data-agent-conversation-message="search12"]')!.getBoundingClientRect();
    const viewport = t.scroll().getBoundingClientRect();
    expect(row.top).toBeGreaterThanOrEqual(viewport.top);
    expect(row.top).toBeLessThan(viewport.bottom);
  });
  it('preserves manual reading across remount and collapses old A2A while following a new owner input to bottom', async () => {
    const t = await mount(800, [turn('a', [delivery('incoming', 'Long agent content '.repeat(500))]), turn('p', [ordinary('Panel answer')])]);
    t.button().click();
    await until('body open', () => !!t.host.querySelector('[data-user-card="incoming"]'));
    t.remount();
    await until('expanded state restored', () => t.head()?.getAttribute('data-expanded') === 'true');
    const input = ordinary('Latest own message', 'user');
    t.state.transcript.history.seed([turn('a', [delivery('incoming')]), turn('p', [ordinary('Panel answer')]), turn('own', [input])]);
    await until('new input mounted', () => !!t.host.querySelector('[data-user-card="Latest own message"]'));
    await until('old body closed', () => !t.host.querySelector('[data-user-card="incoming"]'));
    await untilStable('tail follows shrink', () => [t.scroll().scrollTop, t.scroll().scrollHeight]);
    const card = t.host.querySelector('[data-user-card="Latest own message"]')!.getBoundingClientRect();
    const viewport = t.scroll().getBoundingClientRect();
    expect(card.bottom).toBeLessThanOrEqual(viewport.bottom + 1);
    expect(card.top).toBeGreaterThanOrEqual(viewport.top - 1);
  });
  it('keeps human deliveries and every panel reply visible between the A2A regions', async () => {
    const t = await mount(800, [turn('t', [delivery('a'), ordinary('First panel text'), ordinary('Second panel text'), delivery('human', 'Human group message', 'human'), delivery('b')])]);
    expect(t.host.querySelector('[data-agent-conversation-message="First panel text"]')).not.toBeNull();
    expect(t.host.querySelector('[data-agent-conversation-message="Second panel text"]')).not.toBeNull();
    expect(t.host.querySelector('[data-user-card="human"]')?.textContent).toContain('Human group message');
    expect(t.host.querySelector('[data-user-card="a"]')).toBeNull();
    expect(t.host.querySelector('[data-user-card="b"]')).toBeNull();
  });
  it('updates the same semantic row from pending to received receipt, and stops its light flow when settled', async () => {
    const t = await mount(800, [turn('base', [delivery('incoming')])]);
    const head = t.head();
    const call = { kind: 'mcp-tool-call' as const, id: 'send', toolCallId: 'send', seq: 0, title: 'Send',
      server: 'plugin_gugu-product_gugu', tool: 'message_send', status: 'running' as const,
      rawInput: JSON.stringify({ chat_id: 'group', to_user_ids: [peer], text: 'Real reply content' }) };
    const running: TranscriptTurn = { id: 'running', seq: 1, initiator: 'user', items: [call] };
    t.state.transcript.activeTurn.set(running, 'generating');
    await until('live semantic state', () => t.head()?.getAttribute('data-live') === 'true');
    expect(t.head()).toBe(head);
    expect(t.head()!.textContent).toContain('Received 1 message');
    expect(t.host.querySelector('[data-user-card="send:sent:6417511d-8f36-4cbc-8cbb-81ce9f97df73"]')).toBeNull();
    const finished: TranscriptTurn = { ...running, outcome: { kind: 'done' }, items: [{ ...call, status: 'done',
      outputText: 'sent (id=msg:6417511d-8f36-4cbc-8cbb-81ce9f97df73)' }] };
    batch(() => { t.state.transcript.history.seed([turn('base', [delivery('incoming')]), finished]); t.state.transcript.activeTurn.set(null); });
    await until('settled confirmed count', () => !!t.head()?.textContent?.includes('Exchanged 2 messages'));
    expect(t.head()).toBe(head);
    expect(t.head()!.getAttribute('data-live')).toBe('false');
    expect(t.button().getAttribute('aria-expanded')).toBe('false');
  });
  it('shows the viewer group reply as one source-linked line without unfolding A2A or manufacturing a message', async () => {
    const base: ChatMessage = { ...ordinary('reply:sent:receipt'), text: 'I answered your question.',
      sentAddresses: { target: { kind: 'chat', conversationId: 'group', whisper: false, threadRootId: null },
        recipients: [`user:${me}`], confirmed: true, chatKind: 'group', replyTo: null } };
    const t = await mount(800, [turn('a', [delivery('incoming')]), turn('reply', [base])]);
    const reply = t.host.querySelector<HTMLElement>('[data-group-reply]')!;
    expect(reply.textContent).toContain('Replied to you in gugu');
    expect(reply.getBoundingClientRect().height).toBe(32);
    expect(t.host.querySelector('[data-user-card="reply:sent:receipt"]')).toBeNull();
    reply.querySelector('button')!.click();
    expect(t.open).toHaveBeenCalledWith({ kind: 'chat', chatId: 'group', messageId: 'receipt' });
    expect(t.state.transcript.state.committedTurns[1].items).toHaveLength(1);
  });
  it('keeps an opened group and source identity when older adjacent messages are prepended', async () => {
    const t = await mount(800, [turn('a', [delivery('incoming')]), turn('p', [ordinary('Panel answer')])]);
    const id = t.head()!.dataset.agentActivity;
    t.button().click();
    await until('initial body expanded', () => !!t.host.querySelector('[data-user-card="incoming"]'));
    t.state.transcript.history.seed([turn('old', [delivery('older')]), turn('a', [delivery('incoming')]), turn('p', [ordinary('Panel answer')])]);
    await until('prepended activity visible in same opened region', () => !!t.host.querySelector('[data-user-card="older"]'));
    expect(t.head()!.dataset.agentActivity).toBe(id);
    expect(t.button().getAttribute('aria-expanded')).toBe('true');
  });
  it.each([390, 1280])('pins the open activity header with an opaque backdrop and collapses to the following message (%i)', async width => {
    const records = Array.from({ length: 24 }, (_, i) => turn(`a${i}`, [delivery(`a${i}`, `Update ${i}. `.repeat(45))]));
    const t = await mount(width, [...records, turn('panel', [ordinary('Following conclusion')]), ...Array.from({ length: 15 }, (_, i) => turn(`tail${i}`, [ordinary(`Tail ${i}. `.repeat(20))]))]);
    t.view.scrollToTop();
    await until('top header returned', () => !!t.head());
    t.button().click();
    await untilStable('open group settled', () => t.scroll().scrollHeight);
    t.scroll().scrollTop = 850;
    await untilStable('header stuck', () => t.head()?.getBoundingClientRect().top);
    expect(Math.abs(t.head()!.getBoundingClientRect().top - t.scroll().getBoundingClientRect().top - 8)).toBeLessThan(2);
    const backdrop = t.head()!.closest('[data-index]')!.querySelector('[data-chat-pin-backdrop]')!;
    expect(getComputedStyle(backdrop).opacity).toBe('1');
    t.button().click();
    await until('following conclusion mounted', () => !!t.host.querySelector('[data-user-card="Following conclusion"]'));
    await untilStable('collapse anchor settled', () => [t.scroll().scrollTop, t.scroll().scrollHeight]);
    const conclusion = t.host.querySelector('[data-user-card="Following conclusion"]')!.getBoundingClientRect();
    expect(conclusion.top).toBeGreaterThanOrEqual(t.scroll().getBoundingClientRect().top - 1);
    expect(conclusion.top).toBeLessThan(t.scroll().getBoundingClientRect().bottom);
  });
  it('returns offscreen rows to zero after collapse and a mid-animation history prepend', async () => {
    const records = Array.from({ length: 30 }, (_, i) => turn(`history${i}`, [delivery(`history${i}`, `Long update ${i}. `.repeat(90))]));
    const ending = turn('ending', [ordinary('Visible conclusion')]);
    const t = await mount(800, [...records, ending]);
    const closedHeight = t.scroll().scrollHeight;
    t.button().click();
    await untilStable('all open row heights settled', () => t.scroll().scrollHeight);
    t.scroll().scrollTop = 1100;
    await untilStable('open scrolled position', () => t.scroll().scrollTop);
    t.button().click();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    t.state.transcript.history.seed([turn('earlier', [delivery('earlier')]), ...records, ending]);
    await until('group closed', () => t.button().getAttribute('aria-expanded') === 'false');
    await untilStable('offscreen shrink settled', () => t.scroll().scrollHeight);
    expect(t.scroll().scrollHeight).toBe(closedHeight);
    expect(t.host.querySelector('[data-user-card="Visible conclusion"]')).not.toBeNull();
    t.remount();
    await untilStable('remount preserved collapsed geometry', () => t.scroll().scrollHeight);
    expect(t.scroll().scrollHeight).toBe(closedHeight);
  });
  it('keeps the viewer question pinned above the open A2A header, without either covering the other', async () => {
    const records = [turn('own', [ordinary('Owner question', 'user'), ...Array.from({ length: 24 }, (_, i) => delivery(`a${i}`, `Update ${i}. `.repeat(45))) ]),
      turn('conclusion', [ordinary('Following conclusion')])];
    const t = await mount(800, records);
    t.button().click();
    await untilStable('open activity heights settled', () => t.scroll().scrollHeight);
    t.scroll().scrollTop = 850;
    await untilStable('both sticky lanes settled', () => [t.head()?.getBoundingClientRect().top, t.host.querySelector('[data-user-card="Owner question"]')?.getBoundingClientRect().top]);
    const own = t.host.querySelector('[data-agent-conversation-message="Owner question"]')!.getBoundingClientRect();
    const activity = t.head()!.getBoundingClientRect();
    expect(Math.abs(own.top - t.scroll().getBoundingClientRect().top - 8)).toBeLessThan(2);
    expect(activity.top).toBeGreaterThanOrEqual(own.bottom + 6);
    expect(activity.top - own.bottom).toBeLessThan(20);
  });
  it.each([390, 1280])('pushes the two pinned rows out continuously at the activity end and reverses with the scroll (%i)', async width => {
    const records = [turn('own', [ordinary('Owner question', 'user'), ...Array.from({ length: 24 }, (_, i) => delivery(`a${i}`, `Update ${i}. `.repeat(45))) ]),
      turn('conclusion', [ordinary('Following conclusion. '.repeat(60))]),
      ...Array.from({ length: 12 }, (_, i) => turn(`tail${i}`, [ordinary(`Tail ${i}. `.repeat(20))]))];
    const t = await mount(width, records);
    t.button().click();
    await untilStable('push-out rows measured', () => t.scroll().scrollHeight);
    t.scroll().scrollTop = 850;
    await untilStable('push-out lanes mounted', () => t.head()?.getBoundingClientRect().top);
    const own = () => t.host.querySelector<HTMLElement>('[data-agent-conversation-message="Owner question"]')!;
    const sample = () => ({ scroll: t.scroll().scrollTop, own: own()?.getBoundingClientRect().top,
      activity: t.head()?.getBoundingClientRect().top, opaque: t.head() && getComputedStyle(t.head()!.closest('[data-index]')!.querySelector('[data-chat-pin-backdrop]')!).opacity });
    const row = t.head()!.closest<HTMLElement>('[data-index]')!;
    const end = Number.parseFloat(row.style.top) + Number.parseFloat(row.style.height);
    const samples = [];
    for (let delta = -240; delta <= 40; delta += 8) {
      t.scroll().scrollTop = end + delta;
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      samples.push(sample());
    }
    expect(samples.filter(s => s.activity !== undefined && s.activity > 0 && s.activity < 40)).not.toHaveLength(0);
    for (let i = 1; i < samples.length; i++) {
      const before = samples[i - 1], after = samples[i];
      if (before.activity !== undefined && after.activity !== undefined) expect(Math.abs(after.activity - before.activity)).toBeLessThanOrEqual(9);
    }
    const middle = samples.find(s => s.activity !== undefined && s.activity > 15 && s.activity < 35)!;
    t.scroll().scrollTop = middle.scroll;
    await untilStable('push-out held halfway', () => sample().activity);
    expect(sample().activity).toBeCloseTo(middle.activity!, 0);
    const held = sample();
    await new Promise(resolve => setTimeout(resolve, 90));
    expect(sample()).toEqual(held);
    t.scroll().scrollTop = 850;
    await untilStable('reverse scroll restores the same pins', () => [sample().own, sample().activity]);
    expect(sample().own).toBe(8);
    expect(sample().activity).toBe(108);
    expect(sample().opaque).toBe('1');
  });
  it.each([true, false])('returns pinned rows during the height collapse without skipping to the final anchor (following conclusion: %s)', async following => {
    const t = await mount(800, [turn('own', [ordinary('Owner question', 'user'), ...Array.from({ length: 24 }, (_, i) => delivery(`a${i}`, `Update ${i}. `.repeat(45))) ]),
      ...(following ? [turn('conclusion', [ordinary('Following conclusion. '.repeat(60))]), ...Array.from({ length: 10 }, (_, i) => turn(`tail${i}`, [ordinary(`Tail ${i}. `.repeat(20))]))] : [])]);
    t.button().click();
    await untilStable('collapse source measured', () => t.scroll().scrollHeight);
    t.scroll().scrollTop = 850;
    await untilStable('collapse starts with two pinned rows', () => t.head()?.getBoundingClientRect().top);
    const own = () => t.host.querySelector('[data-agent-conversation-message="Owner question"]')?.getBoundingClientRect();
    const start = t.scroll().scrollTop;
    // Drive the real layout tween with a frame clock. A busy browser can deliver
    // its next animation frame after the entire 200ms duration has elapsed.
    let now = performance.now();
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const positions: number[] = [];
    try {
      t.button().click();
      for (let frame = 1; frame <= 16; frame++) {
        now += 16;
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        positions.push(t.scroll().scrollTop);
        if (frame === 1) expect(own()!.bottom, 'own pin is still visible in the first shrinking frame').toBeGreaterThan(0);
      }
    } finally {
      clock.mockRestore();
    }
    await untilStable('collapse and target position settled', () => [t.scroll().scrollTop, t.scroll().scrollHeight]);
    const end = t.scroll().scrollTop;
    expect(Math.abs(start - end), 'the fixture really moves to its collapsed anchor').toBeGreaterThan(100);
    expect(Math.abs(positions[0] - end), 'the first shrinking frame has not already landed on the conclusion')
      .toBeGreaterThan(1);
    expect(new Set(positions.map(position => Math.round(position))).size, 'collapse passes through multiple real layout positions').toBeGreaterThan(3);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(t.scroll().scrollTop).toBe(end);
    if (following) {
      const conclusion = [...t.host.querySelectorAll<HTMLElement>('[data-agent-conversation-message]')]
        .find(row => row.dataset.agentConversationMessage?.startsWith('Following conclusion.'))!.getBoundingClientRect();
      expect(conclusion.top).toBeGreaterThanOrEqual(t.scroll().getBoundingClientRect().top - 1);
      expect(conclusion.top).toBeLessThan(t.scroll().getBoundingClientRect().bottom);
    }
    expect(t.button().getAttribute('aria-expanded')).toBe('false');
  });
  it.each(['#ffffff', '#212121'])('paints both pinned lanes opaquely without scroll-state containers (%s)', async background => {
    const question = 'Owner question';
    const t = await mount(360, [turn('own', [ordinary(question, 'user'),
      ...Array.from({ length: 24 }, (_, i) => delivery(`opaque${i}`, `Underlying text ${i}. `.repeat(45)))]),
      turn('conclusion', [ordinary('Following conclusion. '.repeat(60))])]);
    t.host.style.setProperty('--chat-bg', background);
    t.button().click();
    await untilStable('opaque-lane source measured', () => t.scroll().scrollHeight);
    // Older Android WebViews do not implement scroll-state queries. Disable
    // those containers while exercising the real sticky layout and paint.
    for (const row of t.host.querySelectorAll<HTMLElement>('[data-index] > div')) row.style.containerType = 'normal';
    const own = () => t.host.querySelector(`[data-agent-conversation-message="${question}"]`)!;
    const masks = () => [own(), t.head()!].map(row => row.closest('[data-index]')!.querySelector<HTMLElement>('[data-chat-pin-backdrop]')!);
    t.scroll().scrollTop = 850;
    await untilStable('both opaque lanes stuck', () => [own().getBoundingClientRect().top, t.head()?.getBoundingClientRect().top]);
    for (const mask of masks()) {
      expect(getComputedStyle(mask).opacity, 'the scrolling body cannot paint through either pinned lane').toBe('1');
      expect(getComputedStyle(mask).backgroundColor).toBe(background === '#ffffff' ? 'rgb(255, 255, 255)' : 'rgb(33, 33, 33)');
    }
    t.scroll().scrollTop = 0;
    await untilStable('opaque lanes return to ordinary bubbles', () => t.head()?.getBoundingClientRect().top);
    for (const mask of masks()) expect(getComputedStyle(mask).opacity).toBe('0');
  });
  it.each([
    { width: 360, background: '#ffffff' }, { width: 1280, background: '#ffffff' },
    { width: 360, background: '#212121' }, { width: 1280, background: '#212121' },
  ])('keeps the pinned semantic line quiet and its page-colored strip inside the row ($width/$background)', async ({ width, background }) => {
    const question = 'A longer owner question above the agent exchange. '.repeat(3);
    const t = await mount(width, [turn('own', [ordinary(question, 'user'),
      ...Array.from({ length: 20 }, (_, i) => delivery(`quiet${i}`, `Long underlying message ${i}. `.repeat(45)))]),
      turn('conclusion', [ordinary('Following conclusion. '.repeat(60))])]);
    if (background === '#212121') t.host.classList.add('emdark');
    t.host.style.setProperty('--chat-bg', background);
    const label = () => t.head()!.lastElementChild as HTMLElement;
    const typography = () => { const s = getComputedStyle(label()); return [s.fontSize, s.lineHeight, s.fontWeight, s.color]; };
    const before = typography();
    t.button().click();
    await untilStable('long messages expanded', () => t.scroll().scrollHeight);
    t.scroll().scrollTop = 850;
    await untilStable('long message scrolls under both pins', () => t.head()?.getBoundingClientRect().top);
    const row = t.head()!.getBoundingClientRect();
    await cdp().send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.left + row.width / 2, y: row.top + row.height / 2 });
    const inlineStyle = getComputedStyle(label());
    expect(typography(), 'pinning or touch hover must not promote the text').toEqual(before);
    expect(inlineStyle.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(inlineStyle.borderRadius).toBe('0px');
    expect(inlineStyle.borderWidth).toBe('0px');
    const lane = t.head()!.closest<HTMLElement>('[data-index]')!;
    const backdrop = lane.querySelector<HTMLElement>('[data-chat-pin-backdrop]')!;
    const paint = backdrop.getBoundingClientRect(), viewport = t.scroll().getBoundingClientRect();
    const style = getComputedStyle(backdrop);
    expect(style.opacity).toBe('1');
    expect(style.backgroundColor).toBe(background === '#ffffff' ? 'rgb(255, 255, 255)' : 'rgb(33, 33, 33)');
    const own = t.host.querySelector('[data-agent-conversation-message]')!.getBoundingClientRect();
    const ownPaint = t.host.querySelector('[data-agent-conversation-message]')!.closest('[data-index]')!.querySelector<HTMLElement>('[data-chat-pin-backdrop]')!.getBoundingClientRect();
    expect(ownPaint.top, 'the reserved top gap above the owner pin must not expose an older body line').toBeLessThanOrEqual(viewport.top);
    expect(Math.abs(paint.top - own.bottom), 'the two page-colored pins meet without exposing half a body line in their seam').toBeLessThan(1);
    expect(Math.abs(paint.bottom - row.bottom), 'no opaque band below the semantic row').toBeLessThan(1);
    expect(paint.left).toBeLessThanOrEqual(viewport.left);
    expect(paint.right).toBeGreaterThanOrEqual(viewport.right - 1);
    expect(getComputedStyle(lane).contain.split(' ')).not.toContain('paint');
    expect(style.borderTopWidth).toBe('0px');
    expect(style.borderLeftWidth).toBe('0px');
    expect(style.borderRightWidth).toBe('0px');
    expect(style.borderBottomWidth).toBe('1px');
    const fadeSelector = pinFade.split(/\s+/).map(name => `.${name}`).join('');
    expect(t.host.querySelectorAll(fadeSelector), 'neither pin may paint a fade across the preceding message').toHaveLength(0);
  });
  it.each(['#ffffff', '#212121'])('covers the reserved viewport gap above a standalone opened activity (%s)', async background => {
    const t = await mount(390, [turn('incoming', Array.from({ length: 16 }, (_, i) => delivery(`standalone${i}`, `Underlying old message ${i}. `.repeat(45)))),
      turn('after', [ordinary('Following conclusion. '.repeat(40))])]);
    if (background === '#212121') t.host.classList.add('emdark');
    t.host.style.setProperty('--chat-bg', background);
    t.button().click();
    await untilStable('standalone activity expanded', () => t.scroll().scrollHeight);
    t.scroll().scrollTop = 650;
    await untilStable('standalone activity stuck', () => t.head()?.getBoundingClientRect().top);
    const mask = t.head()!.closest('[data-index]')!.querySelector<HTMLElement>('[data-chat-pin-backdrop]')!;
    expect(getComputedStyle(mask).opacity).toBe('1');
    expect(getComputedStyle(mask).backgroundColor).toBe(background === '#ffffff' ? 'rgb(255, 255, 255)' : 'rgb(33, 33, 33)');
    expect(mask.getBoundingClientRect().top, 'the unpaired activity must cover its reserved top gap').toBeLessThanOrEqual(t.scroll().getBoundingClientRect().top);
    t.button().click();
    await untilStable('standalone activity closed', () => t.scroll().scrollHeight);
    expect(t.head()!.closest('[data-index]')!.querySelector('[data-chat-pin-backdrop]')).toBeNull();
  });
  it('snaps the pinned exit and manual collapse when reduced motion is enabled', async () => {
    await cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const t = await mount(800, [turn('own', [ordinary('Owner question', 'user'), ...Array.from({ length: 24 }, (_, i) => delivery(`a${i}`, `Update ${i}. `.repeat(45))) ]),
      turn('conclusion', [ordinary('Following conclusion. '.repeat(60))]), ...Array.from({ length: 10 }, (_, i) => turn(`tail${i}`, [ordinary(`Tail ${i}. `.repeat(20))]))]);
    t.button().click();
    await untilStable('reduced motion open geometry', () => t.scroll().scrollHeight);
    const row = t.head()!.closest<HTMLElement>('[data-index]')!;
    t.scroll().scrollTop = Number.parseFloat(row.style.top) + Number.parseFloat(row.style.height) - 80;
    await untilStable('reduced motion exit', () => t.head()?.getBoundingClientRect().top);
    expect(getComputedStyle(t.head()!).visibility).toBe('hidden');
    t.scroll().scrollTop = 850;
    await untilStable('reduced motion reverse', () => t.head()?.getBoundingClientRect().top);
    expect(getComputedStyle(t.head()!).visibility).toBe('visible');
    t.button().click();
    await until('reduced motion content immediately removed', () => !t.host.querySelector('[data-user-card="a0"]'));
    await untilStable('reduced motion final anchor', () => t.scroll().scrollTop);
    expect(t.button().getAttribute('aria-expanded')).toBe('false');
  });
  it('keeps closed activity lanes at header height while idle prefetch measures the surrounding history', async () => {
    const records = Array.from({ length: 18 }, (_, i) => turn(`t${i}`, [delivery(`hidden${i}`, 'A hidden long agent update. '.repeat(100)), ordinary(`Panel reply ${i}`)]));
    const t = await mount(800, records);
    const oversized: number[] = [];
    for (let i = 0; i < 30; i++) {
      t.scroll().scrollTop = i * 80;
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      for (const header of t.host.querySelectorAll<HTMLElement>('[data-agent-activity][data-expanded="false"]')) {
        const height = Number.parseFloat(header.closest<HTMLElement>('[data-index]')!.style.height);
        if (height > 70) oversized.push(height);
      }
    }
    expect(oversized, 'prefetch must not restore reserved height for an invisible folded message').toEqual([]);
  });
});
