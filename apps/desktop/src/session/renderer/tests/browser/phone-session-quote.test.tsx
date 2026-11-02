import { afterEach, expect, it, vi } from 'vitest';
import { act, useState, type ComponentProps } from 'react';
import { page } from 'vitest/browser';
import { SessionConversation } from '@/mobile/agent-watch/SessionConversation';
import { emptyAgentWatchTimeline } from '@/mobile/agent-watch/agent-watch-store';
import { finishRendererContentMenu, RENDERER_CONTENT_MENU_OPEN } from '@/lib/contentContextMenu';
import { messageQuoteText } from '@gugu/core/shared/ui/messageQuote';
import type { ContentContextMenu } from '@shared/content-context-menu';
import type { TranscriptTurn } from '@gugu/session-chat-ui';
import { createReactHarness, renderWithAppProviders, deferred, clickElement } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { i18n } from '@/i18n/runtime';
import '@/styles/tokens.css';
import '@renderer/index.css';

vi.mock('@gugu/core/cloud/config', async original => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: { chatView: 'double' } }) }));
vi.mock('@/mobile/agent-watch/sessionpage-rpc', async original => ({
  ...(await original<object>()),
  SessionpageRpcError: class SessionpageRpcError extends Error {},
  fetchSessionOptions: vi.fn(() => new Promise(() => {})),
  setSessionOption: vi.fn(),
  machineRpc: vi.fn(() => ({})), fetchToolImage: vi.fn(), stopBackgroundTask: vi.fn(), fetchBackgroundTasks: vi.fn(),
}));

const SESSION = 'phone-quote-task';
const SOURCE = 'phone-quote-task:turn:s1:message:source';
const source = { kind: 'session' as const, sessionId: SESSION, itemId: SOURCE };
const turn = (id: string, seq: number, text: string): TranscriptTurn => ({ id: `turn:s${seq}`, seq, initiator: 'user', outcome: { kind: 'done' }, items: [
  { kind: 'message', id, seq: 0, role: 'user', text },
  { kind: 'message', id: `${id}-answer`, seq: 1, role: 'assistant', text: 'Phone original reply' },
] });
let harness: ReturnType<typeof createReactHarness>;
afterEach(() => { vi.useRealTimers(); harness?.cleanup(); });

function conversation(overrides: Partial<ComponentProps<typeof SessionConversation>> = {}) {
  const timeline = emptyAgentWatchTimeline();
  timeline.turns = [turn(SOURCE, 1, 'Phone original message')];
  return <SessionConversation timeline={timeline} deviceId="device" sessionId={SESSION} agentName="Agent" nativeRecord
    sessionRuntime="acp" respondingItemId={null} onRespond={vi.fn()} onSend={vi.fn()} pendingSends={[]} sending={false} agentWorking={false}
    onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()} {...overrides} />;
}
async function mount(node = conversation()) {
  await page.viewport(390, 844);
  harness = createReactHarness();
  harness.container.style.cssText = 'height:700px;width:390px;display:flex;flex-direction:column';
  await renderWithAppProviders(harness, node, { contacts: {} });
}
function preview() {
  return [...harness.container.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === i18n.t('composer.cancelQuote', { ns: 'messaging' }));
}
function editor() { return harness.container.querySelector<HTMLElement>('[contenteditable="true"]')!; }
async function quoteSource() {
  await until('phone source uses the conversation renderer', () => !!harness.container.querySelector(`[data-conversation-text="${SOURCE}"]`));
  const row = harness.container.querySelector<HTMLElement>(`[data-user-card="${SOURCE}"]`)!;
  let previous = '', stable = 0;
  await until('phone composer and virtual rows finish their initial positioning', () => {
    const scroll = harness.container.querySelector<HTMLElement>('[data-chat-scroll]');
    const box = row.getBoundingClientRect();
    const geometry = `${scroll?.scrollTop}/${box.top}/${box.height}/${editor()?.getBoundingClientRect().top}`;
    stable = geometry === previous ? stable + 1 : 0; previous = geometry;
    return stable >= 4;
  });
  const requests: ContentContextMenu[] = [];
  const capture = (event: Event) => requests.push((event as CustomEvent<ContentContextMenu>).detail);
  window.addEventListener(RENDERER_CONTENT_MENU_OPEN, capture);
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    row.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', clientX: 20, clientY: 20, bubbles: true }));
    await vi.advanceTimersByTimeAsync(501);
    expect(requests).toHaveLength(1);
    await act(async () => { expect(requests[0].items.some(item => 'id' in item && item.id === 'quote')).toBe(false); finishRendererContentMenu(requests[0].requestId); });
  } finally { vi.useRealTimers(); window.removeEventListener(RENDERER_CONTENT_MENU_OPEN, capture); }
}

it('does not expose whole-message quoting in the phone host or create a composer quote', async () => {
  await mount();
  await quoteSource();
  expect(preview()).toBeUndefined();
  expect(harness.container.querySelector('[data-user-message-actions] button[aria-label="Quote"]')).toBeNull();
});

it('loads the stored quote source through the phone host once and reveals that exact row', async () => {
  const older = turn(SOURCE, 1, 'Repeated original words');
  const duplicate = turn('different-source', 2, 'Repeated original words');
  const latest = emptyAgentWatchTimeline();
  latest.turns = [...Array.from({ length: 12 }, (_, index) => turn(`recent-${index}`, index + 3, `Recent message ${index}`)),
    turn('stored-quote', 15, messageQuoteText(source, 'Repeated original words', 'User') + 'Read back this stored message')];
  let publish!: (value: typeof latest) => void;
  const pageReady = deferred<void>();
  const loadOlder = vi.fn(async () => {
    await pageReady.promise;
    publish({ ...latest, turns: [older, duplicate, ...latest.turns], hasOlder: false });
  });
  function Host() {
    const [timeline, setTimeline] = useState(latest);
    publish = setTimeline;
    return conversation({ timeline, onLoadOlder: async () => { if (timeline.hasOlder) await loadOlder(); } });
  }
  await mount(<Host />);
  const quoteSelector = '[data-slot="conversation-quote"]';
  await until('phone history has its real scroll container', () => !!harness.container.querySelector('[data-chat-scroll]'));
  const history = harness.container.querySelector<HTMLElement>('[data-chat-scroll]')!;
  history.scrollTop = history.scrollHeight;
  history.dispatchEvent(new Event('scroll'));
  await until('the stored quote excerpt has a reveal action', () => !!harness.container.querySelector(quoteSelector));
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  // Enable pagination after the initial top-edge layout, as a host metadata refresh would.
  await act(async () => publish({ ...latest, hasOlder: true }));
  loadOlder.mockClear();
  await act(async () => {
    const arrow = harness.container.querySelector<HTMLElement>(quoteSelector)!;
    arrow.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
    arrow.click();
  });
  await until('phone tap previews the stored quote', () => !!document.querySelector('[data-slot="conversation-quote-preview"]'));
  expect(document.querySelector('[data-slot="conversation-quote-preview"]')?.textContent).toContain('Repeated original words');
  expect(loadOlder, 'previewing alone does not fetch or navigate').not.toHaveBeenCalled();
  await clickElement(document.querySelector<HTMLElement>('[data-slot="conversation-quote-preview"]')!);
  try {
    await until('quote requests its missing page', () => loadOlder.mock.calls.length > 0);
    const scroll = harness.container.querySelector<HTMLElement>('[data-chat-scroll]')!;
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event('scroll'));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(loadOlder, 'top-edge pagination shares the quote reveal request').toHaveBeenCalledOnce();
  } finally { await act(async () => pageReady.resolve()); }
  await until('phone flashes the loaded stored source', () => !!harness.container.querySelector(`[data-item-id="${SOURCE}"].msg-src-flash`));
  expect(loadOlder).toHaveBeenCalledOnce();
  const rows = harness.container.querySelectorAll<HTMLElement>(`[data-item-id="${SOURCE}"]`);
  expect(rows).toHaveLength(1);
  expect(harness.container.querySelector('[data-item-id="different-source"].msg-src-flash')).toBeNull();
  const row = rows[0], scroll = harness.container.querySelector<HTMLElement>('[data-chat-scroll]')!;
  expect(row.getBoundingClientRect().top).toBeGreaterThanOrEqual(scroll.getBoundingClientRect().top);
  expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(editor().getBoundingClientRect().top);
});
