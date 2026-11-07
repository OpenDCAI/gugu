import { createChatContext, createChatState, type ChatView, type TranscriptTurn } from '@gugu/session-chat-ui';
import { ChatComposer, MessageProvider, type PromptEditorRef } from '@gugu/session-ui/react/components';
import { ThemeProvider } from '@gugu/session-ui/react/primitives';
import { AgentConversationView } from '@renderer/lib/chat/agent-conversation-view';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { platform } from '@/platform';
import { createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { until, untilStable } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';
import '@/mobile/phone-look.css';

const cleanups: (() => void)[] = [];
const originalKind = Object.getOwnPropertyDescriptor(platform, 'kind')!;
const originalTheme = document.documentElement.dataset.theme;
afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup());
  Object.defineProperty(platform, 'kind', originalKind);
  if (originalTheme) document.documentElement.dataset.theme = originalTheme;
  else delete document.documentElement.dataset.theme;
});

async function mount(kind: typeof platform.kind, width: number) {
  await page.viewport(width, 844);
  Object.defineProperty(platform, 'kind', { configurable: true, value: kind });
  document.documentElement.dataset.theme = 'light';
  const context = createChatContext({ locale: () => 'en-US', selfIdentity: () => ({ userId: 'owner', displayName: 'You', guguNumber: null }) });
  const state = createChatState(context);
  const host = document.body.appendChild(document.createElement('div'));
  host.className = 'emlight';
  host.setAttribute('data-ta-scope', '');
  host.style.cssText = 'position:fixed;inset:0;display:flex;background:var(--background);color:var(--foreground)';
  if (kind === 'capacitor' || kind === 'web' && width < 720) host.setAttribute('data-phone-shell', '');
  const root = createRoot(host);
  const editor = createRef<PromptEditorRef>();
  let view!: ChatView;
  let mounts = 0;
  root.render(<ThemeProvider><MessageProvider locale="en-US" translate={translateSessionMessage}>
    <AgentConversationView context={context} state={state} onReady={ready => { view = ready; mounts++; }}
      composerContent={<ChatComposer mobile={kind !== 'electron' && width < 720} hideLockedAgent agentLocked editorApiRef={editor}
        onSubmit={text => {
          state.session.setPendingPrompt({ id: 'own-message', text, sentAt: Date.now(), held: true, delivery: { state: 'sending' } });
          editor.current!.clear();
        }} />} />
  </MessageProvider></ThemeProvider>);
  cleanups.push(() => { root.unmount(); state.dispose(); context.dispose(); host.remove(); });
  await until('conversation composer mounted', () => !!view && !!host.querySelector('[data-testid="prompt-editor"]'));
  const scroller = host.querySelector<HTMLElement>('[data-chat-scroll]')!;
  const card = () => host.querySelector<HTMLElement>('[data-user-card="own-message"]');
  const wrapper = () => card()?.closest('[data-index]')?.firstElementChild as HTMLElement | null;
  const pinned = () => wrapper() != null && getComputedStyle(wrapper()!).position === 'sticky';
  const top = () => card()!.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  const reply = () => {
    const turn: TranscriptTurn = { id: 'running-turn', seq: 0, initiator: 'user', items: [
      { kind: 'message', id: 'own-message', seq: 0, role: 'user', text: 'Please keep my sent message in the conversation.' },
      ...Array.from({ length: 90 }, (_, i) => ({ kind: 'message' as const, id: `reply-${i}`, seq: i + 1, role: 'assistant' as const,
        text: `Response ${i + 1}: this reply leaves enough room to exercise transcript scrolling.` })),
    ] };
    state.transcript.activeTurn.set(turn, 'generating');
    state.session.setPendingPrompt(null);
  };
  const scrollTo = async (value: number) => {
    scroller.scrollTop = value;
    await untilStable('transcript scroll settles', () => [scroller.scrollTop, scroller.scrollHeight]);
  };
  return { host, card, wrapper, pinned, top, reply, scrollTo, scroller, composer: view.composerSlot!, mounts: () => mounts };
}

it.each([
  { kind: 'web' as const, width: 390, pins: false },
  { kind: 'capacitor' as const, width: 1000, pins: false },
  { kind: 'web' as const, width: 1000, pins: true },
  { kind: 'electron' as const, width: 390, pins: true },
])('$kind at $width px keeps sent messages visible with pinning=$pins', async ({ kind, width, pins }) => {
  const t = await mount(kind, width);
  await page.getByTestId('prompt-editor').fill('Please keep my sent message in the conversation.');
  await page.getByRole('button', { name: translateSessionMessage('composer.sendMessage') }).click();
  await until('locally submitted user message text appears', () => t.card()?.textContent?.includes('Please keep my sent message in the conversation.') === true);
  const sent = t.card()!.getBoundingClientRect();
  const composer = t.composer.getBoundingClientRect();
  expect(sent.height).toBeGreaterThan(0);
  expect(sent.top).toBeGreaterThanOrEqual(t.scroller.getBoundingClientRect().top);
  expect(sent.bottom).toBeLessThanOrEqual(composer.top);
  expect(t.pinned()).toBe(pins);
  if (!pins) expect(t.wrapper()!.querySelector('[data-chat-pin-backdrop]')).toBeNull();

  t.reply();
  await until('running reply supplies scrollable content', () => t.scroller.scrollHeight > 2000);
  await t.scrollTo(0);
  const initialTop = t.top();
  await t.scrollTo(200);
  expect(t.pinned()).toBe(pins);
  if (pins) {
    const pinnedTop = t.top();
    expect(pinnedTop).toBeGreaterThanOrEqual(0);
    await t.scrollTo(300);
    expect(t.top()).toBeCloseTo(pinnedTop, 0);
  } else expect(t.top()).toBeCloseTo(initialTop - 200, 0);
  expect(t.mounts()).toBe(1);
});

it('updates phone pinning on a retained web transcript without remounting', async () => {
  const t = await mount('web', 1000);
  t.reply();
  await until('desktop user message mounted', () => t.card() != null && t.pinned());
  await page.viewport(390, 844);
  await until('phone layout disables the existing pin lane', () => t.wrapper() != null && !t.pinned());
  expect(t.wrapper()!.querySelector('[data-chat-pin-backdrop]')).toBeNull();
  await page.viewport(1000, 844);
  await until('desktop layout restores its pin lane', t.pinned);
  expect(t.mounts()).toBe(1);
});
