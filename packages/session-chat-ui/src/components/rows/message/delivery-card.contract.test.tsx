/** @jsxImportSource solid-js */
/**
 * Delivered inputs use the ordinary user bubble and a compact source line.
 * Rendering and measurement must agree for both layouts, expanded bodies,
 * source details and batch changes, without exposing edit actions for deliveries.
 */
import { CachesContext } from '@session-chat/components/contexts/CachesContext';
import { CommandsContext } from '@session-chat/components/contexts/CommandsContext';
import { ThemeContext } from '@session-chat/components/contexts/ThemeContext';
import { createChatCaches } from '@session-chat/core/caches';
import { DEFAULT_CONFIG, buildChatTheme } from '@session-chat/core/config';
import type { ChatLayout } from '@session-chat/core/layout/preset';
import type { MeasureCtx, RenderCtx } from '@session-chat/core/define';
import type { ChatMessage } from '@session-chat/model';
import { render } from 'solid-js/web';
import { describe, expect, it } from 'vitest';
import { deliveryFactsId } from './DeliveryCard';
import { messageUnitDef, normalizeMessage } from './message.def';
import { SelfIdentityProvider, type SelfIdentity } from '@session-chat/lib/self-identity';
import { SenderAvatarProvider, SenderNameProvider } from '@session-chat/lib/sender-avatar';
import { AppNameProvider } from '@session-chat/lib/app-name';
import { ChatNameProvider } from '@session-chat/lib/chat-name';
import { createSignal } from 'solid-js';

const WIDTH = 640;
const ENVELOPE = `<gugu_delivery route="chat" arrival="Sent to you through 咕咕; reply with message_reply" from="Alice" from_id="user:alice" chat="7" chat_kind="group" msg="msg:m-1" at="2026-09-03 12:00">
  <reply_to msg="msg:quoted" from_id="user:bob" from="Bob"><![CDATA[the earlier plan]]></reply_to>
  <![CDATA[Please **review** the auth refactor before merging.]]>
</gugu_delivery>`;

const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

type Reading = {
  computed: number;
  dom: number;
  left: number;
  width: number;
  /** `image` + the drawn URL, or `empty` (the slot keeps its width either way). */
  avatar: { state: string | null; src: string | null; width: number };
  sender: string | null;
  route: string | null;
  /** The「时刻」row of the details tier — null while folded (the header no longer shows it). */
  time: string | null;
  senderFact: string | null;
  reply: string | null;
  factsShown: boolean;
  factRows: number;
  bodyText: string;
  boxBorder: string;
  bubble: { left: number; width: number; height: number; radius: string; background: string } | null;
  sourceOutsideBubble: boolean;
  editAction: boolean;
  bubbleCount: number;
  attachmentCount: number;
  openedAttachmentIds: string[];
};

async function mount(
  layout: ChatLayout,
  factsOpen: boolean,
  text = ENVELOPE,
  patch: (item: ChatMessage) => ChatMessage = (item) => item,
  self: SelfIdentity | null = null,
  senderAvatar: (fromId: string | null) => string | null = () => null,
  beforeRead: (host: HTMLDivElement) => void = () => {},
  bodyExpanded = false,
  appName: (appId: string) => string | null = () => null,
  chatName: (chatId: string) => string | null = () => null,
  senderName: (fromId: string | null) => string | null = () => null,
  width = WIDTH,
): Promise<Reading> {
  const raw: ChatMessage = { kind: 'message', id: 'd1', seq: 0, role: 'user', text };
  const item = patch(normalizeMessage(raw));
  const theme = buildChatTheme(DEFAULT_CONFIG, layout);
  const caches = createChatCaches();
  const expanded = (id: string) => factsOpen && id === deliveryFactsId(item.id);
  const measureCtx: MeasureCtx = {
    theme,
    width,
    isCollapsed: expanded,
    expanded,
    caches,
    expandedId: bodyExpanded ? item.id : null,
  };
  const renderCtx: RenderCtx = {
    viewState: { isCollapsed: expanded },
    measureCtx: () => measureCtx,
  };
  const host = document.createElement('div');
  host.style.width = `${width}px`;
  host.dataset.chatLayout = layout.preset;
  document.body.appendChild(host);
  const Comp = messageUnitDef.Render;
  const openedAttachmentIds: string[] = [];
  const dispose = render(
    () => (
      <SelfIdentityProvider value={() => self}>
       <SenderAvatarProvider value={senderAvatar}>
       <SenderNameProvider value={senderName}>
       <AppNameProvider value={appName}>
       <ChatNameProvider value={chatName}>
        <ThemeContext.Provider value={() => theme}>
          <CachesContext.Provider value={caches}>
            <CommandsContext.Provider value={() => ({
              canRevertMessage: () => true, onEditMessage: () => {},
              onViewAttachment: ({ attachment }) => { openedAttachmentIds.push(attachment.id); },
            })}>
              <Comp data={item} ctx={renderCtx} vars={messageUnitDef.vars!} />
            </CommandsContext.Provider>
          </CachesContext.Provider>
        </ThemeContext.Provider>
       </ChatNameProvider>
       </AppNameProvider>
       </SenderNameProvider>
       </SenderAvatarProvider>
      </SelfIdentityProvider>
    ),
    host
  );
  try {
    await nextPaint();
    beforeRead(host);
    await nextPaint();
    const card = host.querySelector<HTMLElement>('[data-delivery-batch]') ?? host.querySelector<HTMLElement>('[data-delivery-card]') ?? host.firstElementChild as HTMLElement;
    if (!card) throw new Error('message did not mount');
    const hostRect = host.getBoundingClientRect();
    const rect = card.getBoundingClientRect();
    const q = (slot: string) => card.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
    const bubble = card.querySelector<HTMLElement>('[data-user-card]');
    const bubbleRect = bubble?.getBoundingClientRect();
    const bubbleStyle = bubble ? getComputedStyle(bubble) : null;
    card.querySelectorAll<HTMLButtonElement>('[data-attachment-chip]').forEach((button) => button.click());
    return {
      computed: messageUnitDef.measure(item, { ...measureCtx, senderName }, messageUnitDef.vars!),
      dom: card.offsetHeight,
      left: rect.left - hostRect.left,
      width: rect.width,
      avatar: {
        state: q('delivery-avatar')?.dataset.avatarState ?? null,
        src: q('delivery-avatar')?.querySelector('img')?.getAttribute('src') ?? null,
        width: q('delivery-avatar')?.getBoundingClientRect().width ?? 0,
      },
      sender: q('delivery-sender')?.textContent ?? null,
      route: q('delivery-route')?.textContent ?? null,
      time: card.querySelector<HTMLElement>('[data-fact="at"]')?.textContent ?? null,
      senderFact: card.querySelector<HTMLElement>('[data-fact="sender"]')?.textContent ?? null,
      reply: q('delivery-reply')?.textContent ?? null,
      factsShown: q('delivery-facts') !== null,
      factRows: card.querySelectorAll('[data-fact]').length,
      bodyText: card.querySelector('[data-gugu-body]')?.textContent ?? '',
      boxBorder: getComputedStyle(card).borderTopWidth,
      bubble: bubbleRect && bubbleStyle ? {
        left: bubbleRect.left - hostRect.left, width: bubbleRect.width, height: bubbleRect.height,
        radius: bubbleStyle.borderRadius, background: bubbleStyle.backgroundColor,
      } : null,
      sourceOutsideBubble: Boolean(q('delivery-header') && !bubble?.contains(q('delivery-header'))),
      editAction: Boolean(card.querySelector('button[aria-label="Edit message"]')),
      bubbleCount: card.querySelectorAll('[data-user-card]').length,
      attachmentCount: card.querySelectorAll('[data-attachment-chip]').length,
      openedAttachmentIds,
    };
  } finally {
    dispose();
    host.remove();
    caches.clearAll();
  }
}

const SINGLE: ChatLayout = { preset: 'single', userGutter: 0 };
const DOUBLE: ChatLayout = { preset: 'double', userGutter: 72 };

it.each([{ newName: 'Renamed identity', width: WIDTH }, { newName: 'W'.repeat(40), width: 220 }])('updates historical sender and quote labels in place at width $width', async ({ newName, width }) => {
  const [name, setName] = createSignal('Current identity');
  const [quoteName, setQuoteName] = createSignal('Current quoted identity');
  const notice = ENVELOPE.replace('route="chat"', 'route="system"');
  let initialSender: string | null = null;
  const initialReply: { text: string | null } = { text: null };
  let initialBody = '';
  let initialHeight = 0;
  const renamed = await mount(DOUBLE, false, notice, (item) => item, null, () => null,
    (host) => {
      initialSender = host.querySelector('[data-slot="delivery-sender"]')?.textContent ?? null;
      initialReply.text = host.querySelector('[data-slot="delivery-reply"]')?.textContent ?? null;
      initialBody = host.querySelector('[data-gugu-body]')?.textContent ?? '';
      initialHeight = (host.querySelector('[data-delivery-card]') as HTMLElement).offsetHeight;
      setName(newName);
      setQuoteName('Updated quoted identity');
    }, false, () => null, () => null, id => id === 'user:alice' ? name() : id === 'user:bob' ? quoteName() : null, width);
  expect(initialSender).toBe('Current identity');
  expect(renamed.sender?.replace(/\n/g, '')).toBe(newName);
  expect(initialReply.text?.replace(/\n/g, '')).toContain('Current quoted identity');
  expect(renamed.reply?.replace(/\n/g, '')).toContain('Updated quoted identity');
  expect(renamed.computed).toBe(renamed.dom);
  if (width === WIDTH) expect(renamed.dom).toBe(initialHeight);
  else expect(renamed.dom).toBeGreaterThan(initialHeight);
  expect(renamed.bodyText).toBe(initialBody);
});

describe('plain session delivery contract', () => {
  it.each([SINGLE, DOUBLE])('renders only the received words in $preset, with exact measured geometry', async (layout) => {

    const delivered = await mount(layout, false);
    const typed = await mount(layout, false, 'Please **review** the auth refactor before merging.');
    expect(delivered.computed).toBe(delivered.dom);
    expect(delivered.bubble).not.toBeNull();
    expect(delivered.bubble).toEqual(typed.bubble);
    expect(delivered.bodyText).toContain('review');
    expect(delivered.sender).toBeNull();
    expect(delivered.route).toBeNull();
    expect(delivered.reply).toBeNull();
    expect(delivered.avatar).toEqual({ state: null, src: null, width: 0 });
    expect(delivered.editAction).toBe(false);
    expect(typed.editAction).toBe(true);
  });

  it('a stale expanded-details id does not reserve hidden height or expose envelope metadata', async () => {
    const closed = await mount(SINGLE, false);
    const open = await mount(SINGLE, true);
    expect(open.computed).toBe(open.dom);
    expect(open.dom).toBe(closed.dom);
    expect(open.factRows).toBe(0);
    expect(open.factsShown).toBe(false);
  });

  it('a direct session input hides identity and quote metadata even when a host supplies an avatar', async () => {
    const input = ENVELOPE.replace('route="chat"', 'route="session-direct"');
    const result = await mount(SINGLE, false, input, item => item, null, () => 'data:image/png;base64,AA==');
    expect(result.computed).toBe(result.dom);
    expect(result.sender).toBeNull();
    expect(result.reply).toBeNull();
    expect(result.avatar.src).toBeNull();
    expect(result.bodyText).toContain('review');
  });

  it('retains source and inspectable facts for system notices outside the chat surface', async () => {
    const input = ENVELOPE.replace('route="chat"', 'route="system"');
    const result = await mount(SINGLE, true, input);
    expect(result.computed).toBe(result.dom);
    expect(result.sender).toBe('Alice');
    expect(result.route).toBe('from 咕咕');
    expect(result.factRows).toBeGreaterThan(0);
  });

  it('expands long delivered bodies by the same amount as typed bodies', async () => {
    const text = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}: a longer input to read.`).join('\n\n');
    const envelope = ENVELOPE.replace('Please **review** the auth refactor before merging.', text);
    const closed = await mount(DOUBLE, false, envelope);
    const open = await mount(DOUBLE, false, envelope, (item) => item, null, () => null, () => {}, true);
    const typed = await mount(DOUBLE, false, text, (item) => item, null, () => null, () => {}, true);
    expect(closed.computed).toBe(closed.dom);
    expect(open.computed).toBe(open.dom);
    expect(open.bubble).toEqual(typed.bubble);
    expect(open.bubble!.height).toBeGreaterThan(closed.bubble!.height);
  });

  it('reacts when a reused delivery changes from one input to a batch', async () => {
    const [batched, setBatched] = createSignal(false);
    const r = await mount(DOUBLE, false, ENVELOPE, (item) => ({
      ...item,
      get guguDelivery() {
        const first = item.guguDelivery!;
        return batched() ? { ...first, segments: [...first.segments, ...first.segments] } : first;
      },
    }), null, () => null, () => setBatched(true));
    expect(r.bubbleCount).toBe(2);
    expect(r.computed).toBe(r.dom);
  });

  it('keeps each attachment with its own received input in a batch', async () => {
    const first = '<gugu_delivery route="chat" from="Alice" from_id="user:alice" msg="m-a"><![CDATA[First @[a.txt](/tmp/a.txt)]]></gugu_delivery>';
    const second = '<gugu_delivery route="chat" from="Bob" from_id="user:bob" msg="m-b"><![CDATA[Second @[b.txt](/tmp/b.txt)]]></gugu_delivery>';
    const r = await mount(DOUBLE, false, `${first}\n${second}`);
    expect(r.bubbleCount).toBe(2);
    expect(r.attachmentCount).toBe(2);
    expect(r.computed).toBe(r.dom);
  });

  it('opens the correct files when two received inputs have the same attachment name', async () => {
    const first = '<gugu_delivery route="chat" from="Alice" from_id="user:alice" msg="m-a"><![CDATA[First @[image.png](/a/image.png)]]></gugu_delivery>';
    const second = '<gugu_delivery route="chat" from="Bob" from_id="user:bob" msg="m-b"><![CDATA[Second @[image.png](/b/image.png)]]></gugu_delivery>';
    const r = await mount(DOUBLE, false, `${first}\n${second}`);
    expect(r.openedAttachmentIds).toEqual(['path:/a/image.png', 'path:/b/image.png']);
    expect(r.computed).toBe(r.dom);
  });

});
