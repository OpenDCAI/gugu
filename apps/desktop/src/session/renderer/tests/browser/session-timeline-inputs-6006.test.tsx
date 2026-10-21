import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { createChatContext, createChatState, createChatView, pinTopMode } from '@gugu/session-chat-ui';
import type { ChatContext, ChatState, ChatView, TranscriptTurn } from '@gugu/session-chat-ui';
import { SessionTimeline } from '@renderer/features/sessions/view/session-timeline';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import '@renderer/index.css';
import { until } from '../../../../../../../tests/support/awaitCondition';

const harness = vi.hoisted(() => ({
  store: undefined as { chatState: ChatState; messageCount: number; scrollToItem: (id: string) => void } | undefined,
  context: undefined as ChatContext | undefined,
}));
vi.mock('@renderer/features/sessions/acp/acp-chat-resource-manager', () => ({
  findAcpChatStore: () => harness.store,
}));
vi.mock('@renderer/features/sessions/stores/session-registry', () => ({
  sessionRegistry: { get: () => undefined },
}));
vi.mock('@renderer/lib/chat/shared-chat-context', () => ({
  getSharedChatContext: () => harness.context,
}));

const message = (id: string, role: 'user' | 'assistant', text: string) =>
  ({ kind: 'message', id, seq: 0, role, text }) as TranscriptTurn['items'][number];
const delivery = (route: 'session-direct' | 'chat', body: string, chatKind = 'group') =>
  `<gugu_delivery route="${route}" from="Coordinator" from_id="user:coordinator" chat="Work" chat_kind="${chatKind}"><![CDATA[${body}]]></gugu_delivery>`;
const turn = (id: string, items: TranscriptTurn['items']): TranscriptTurn => ({
  id, seq: id === 'parent' ? 1 : 2, initiator: 'user', items,
});
const parent = turn('parent', [
  message('assignment', 'user', delivery('session-direct', 'original assignment')),
  message('ack', 'assistant', 'ready'),
]);
const liveItems = () => [
  message('manual', 'user', 'start work'),
  message('initial-reply', 'assistant', 'working'),
  message('group-input', 'user', delivery('chat', 'group follow-up')),
  message('group-reply', 'assistant', 'group answer'),
  message('topic-input', 'user', delivery('chat', 'topic follow-up', 'topic')),
  message('topic-reply', 'assistant', 'topic answer'),
];
let root: Root;
let host: HTMLDivElement;
let state: ChatState;
let view: ChatView;
let context: ChatContext;

beforeEach(() => {
  context = createChatContext();
  context.setLayout({ preset: 'double', userGutter: 72 });
  state = createChatState(context);
  state.transcript.history.seed([parent]);
  harness.context = context;
  harness.store = {
    chatState: state,
    // Kept constant deliberately: text and active-turn changes must be observed
    // from Solid, without an unrelated MobX count/status render to rescue them.
    messageCount: 2,
    scrollToItem: (id) => {
      view.setScrollMode(pinTopMode(id));
      state.scroll.set(pinTopMode(id));
    },
  };
  host = document.createElement('div');
  host.className = 'gugu-skin emlight';
  host.style.cssText = 'position:relative;width:900px;height:560px';
  document.body.append(host);
  root = createRoot(host);
  root.render(
    <SessionLocalizationProvider>
      <SessionTimeline sessionId="session" />
      <div style={{ height: 560, marginLeft: 40 }} ref={(element) => {
        if (!element) return;
        view = createChatView({ context, state, parent: element });
        return () => view.dispose();
      }} />
    </SessionLocalizationProvider>,
  );
});
afterEach(() => {
  root.unmount();
  state.dispose();
  context.dispose();
  host.remove();
  harness.store = undefined;
  harness.context = undefined;
});
const ticks = () => [...host.querySelectorAll<HTMLButtonElement>('[data-tick-index]')];
const tickFor = (text: string) => ticks().find((tick) => tick.getAttribute('aria-label')?.includes(text))!;

async function expectJump(prompt: string, itemId: string) {
  await until(`tick for "${prompt}" renders`, () => Boolean(tickFor(prompt)));
  tickFor(prompt).click();
  await until(`"${itemId}" scrolled into view`, () => {
    const row = host.querySelector<HTMLElement>(`[data-item-id="${itemId}"]`);
    const scroller = host.querySelector<HTMLElement>('[data-chat-scroll]');
    if (!row || !scroller) return false;
    const bounds = row.getBoundingClientRect();
    const viewport = scroller.getBoundingClientRect();
    return bounds.top >= viewport.top - 1 && bounds.top < viewport.bottom;
  });
}

describe('#6006 live minimap inputs', () => {
  it('adds each live group/topic input and updates its preview without changing the item count', async () => {
    await until('1 minimap tick', () => ticks().length === 1);
    state.transcript.activeTurn.set(turn('live', liveItems()));
    await until('4 minimap ticks', () => ticks().length === 4);
    expect(tickFor('original assignment').dataset.tickSender).toBe('session');
    expect(tickFor('group follow-up').dataset.tickSender).toBe('group');
    expect(tickFor('topic follow-up').dataset.tickSender).toBe('chat');
    await page.elementLocator(tickFor('topic follow-up')).hover();
    await until('preview shows the topic answer', () => document.querySelector('[data-slot="preview-card-content"]')?.textContent?.includes('topic answer') === true);
    const changed = liveItems();
    changed[changed.length - 1] = message('topic-reply', 'assistant', 'updated topic answer');
    state.transcript.activeTurn.set(turn('live', changed));
    await until('preview shows the updated answer', () => document.querySelector('[data-slot="preview-card-content"]')?.textContent?.includes('updated topic answer') === true);
    expect(ticks()).toHaveLength(4);
    await expectJump('group follow-up', 'group-input');
    await expectJump('topic follow-up', 'topic-input');
  });

  it('keeps completed/replayed mid-turn inputs outside process folds and navigable', async () => {
    state.transcript.history.seed([parent, { ...turn('live', liveItems()), outcome: { kind: 'done' } }]);
    await until('4 minimap ticks', () => ticks().length === 4);
    await expectJump('group follow-up', 'group-input');
    await expectJump('topic follow-up', 'topic-input');
    expect(state.scroll.get()).toMatchObject({ kind: 'anchor', itemId: 'topic-input' });
    state.transcript.history.seed([parent]);
    await until('1 minimap tick', () => ticks().length === 1);
  });
});
