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
import { SenderAvatarProvider } from '@session-chat/lib/sender-avatar';
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
  beforeRead: () => void = () => {},
  bodyExpanded = false,
  appName: (appId: string) => string | null = () => null,
  chatName: (chatId: string) => string | null = () => null,
): Promise<Reading> {
  const raw: ChatMessage = { kind: 'message', id: 'd1', seq: 0, role: 'user', text };
  const item = patch(normalizeMessage(raw));
  const theme = buildChatTheme(DEFAULT_CONFIG, layout);
  const caches = createChatCaches();
  const expanded = (id: string) => factsOpen && id === deliveryFactsId(item.id);
  const measureCtx: MeasureCtx = {
    theme,
    width: WIDTH,
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
  host.style.width = `${WIDTH}px`;
  host.dataset.chatLayout = layout.preset;
  document.body.appendChild(host);
  const Comp = messageUnitDef.Render;
  const openedAttachmentIds: string[] = [];
  const dispose = render(
    () => (
      <SelfIdentityProvider value={() => self}>
       <SenderAvatarProvider value={senderAvatar}>
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
       </SenderAvatarProvider>
      </SelfIdentityProvider>
    ),
    host
  );
  try {
    await nextPaint();
    beforeRead();
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
      computed: messageUnitDef.measure(item, measureCtx, messageUnitDef.vars!),
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

describe('delivery card contract (#4874)', () => {
  it('at rest: a user bubble with one source line and reply, no outer box; measure === offsetHeight', async () => {
    const r = await mount(SINGLE, false);
    expect(r.computed).toBe(r.dom);
    // No host resolver ⇒ no avatar is drawn (#6306: no initial-letter stand-in), the slot keeps its width.
    expect(r.avatar).toEqual({ state: 'empty', src: null, width: 18 });
    expect(r.sender).toBe('Alice');
    expect(r.route).toBe('via a group');
    // Progressive disclosure (owner 2026-09-04): the time waits in the details tier.
    expect(r.time).toBeNull();
    expect(r.reply).toBe('Replying to Bob: the earlier plan');
    expect(r.factsShown).toBe(false);
    expect(r.bodyText).toContain('review');
    expect(r.bodyText).not.toContain('gugu_delivery');
    expect(r.boxBorder).toBe('0px');
  });

  it('the details tier lists the remaining facts as labelled rows, time first', async () => {
    const open = await mount(SINGLE, true);
    expect(open.computed).toBe(open.dom);
    expect(open.time).toBe('2026-09-03 12:00');
    // at · sender(id) · route(chat anchor) · message · reply_to — the five facts this envelope carries.
    expect(open.factRows).toBe(5);
  });

  it('expanding the facts grows the card by exactly the facts box and keeps the contract', async () => {
    const closed = await mount(SINGLE, false);
    const open = await mount(SINGLE, true);
    expect(open.computed).toBe(open.dom);
    expect(open.factsShown).toBe(true);
    expect(open.dom).toBeGreaterThan(closed.dom);
  });

  it('a facts-less envelope with the details id open paints no phantom facts band', async () => {
    // Review finding on #4878: measure used to reserve the facts box whenever the
    // collapse id was open, while render only draws it when there is facts text —
    // the card paints its measured bands, so that showed up as ~126px of blank
    // card bottom rather than a measure/DOM mismatch.
    const factsLess = (item: ChatMessage): ChatMessage => ({
      ...item,
      guguDelivery: { body: item.guguDelivery!.body, segments: [{ facts: null, body: item.guguDelivery!.body }] },
    });
    const closed = await mount(SINGLE, false, ENVELOPE, factsLess);
    const open = await mount(SINGLE, true, ENVELOPE, factsLess);
    expect(open.factsShown).toBe(false);
    expect(open.dom).toBe(closed.dom);
    expect(open.computed).toBe(closed.computed);
  });

  it.each([SINGLE, DOUBLE])('uses the same bubble as a typed message in $preset', async (layout) => {
    const delivered = await mount(layout, false);
    const typed = await mount(layout, false, 'Please **review** the auth refactor before merging.');
    expect(delivered.computed).toBe(delivered.dom);
    expect(typed.computed).toBe(typed.dom);
    expect(delivered.bubble).not.toBeNull();
    expect(delivered.bubble).toEqual(typed.bubble);
    expect(delivered.sourceOutsideBubble).toBe(true);
    // Even an overly permissive host must not offer to edit another sender's input.
    expect(typed.editAction).toBe(true);
    expect(delivered.editAction).toBe(false);
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

  it('keeps the typed user address in details but removes it from the sender title', async () => {
    const fromId = 'user:11111111-1111-4111-8111-111111111111';
    const named = `<gugu_delivery route="chat" from="Claude 16 (${fromId})" from_id="${fromId}" chat="7" msg="msg:m-title" at="2026-09-07 03:00">
  <![CDATA[请看这条外部消息]]>
</gugu_delivery>`;
    const closed = await mount(SINGLE, false, named);
    expect(closed.sender).toBe('Claude 16');
    expect(closed.sender).not.toContain('user:');

    const open = await mount(SINGLE, true, named);
    expect(open.senderFact).toBe(`Claude 16 (${fromId}) · ${fromId}`);

    const idOnly = named.replace(` from="Claude 16 (${fromId})"`, '');
    expect((await mount(SINGLE, false, idOnly)).sender).toBe(fromId);
  });

  // #5048 自己发的消息:认得出是我(本地 profile)就写「我」(gugu-dev#181「我 来自 官网」),不来自信封;别人的照旧只信信封。
  it('names the signed-in user as You, and never guesses for anyone else', async () => {
    const OWN = `<gugu_delivery route="chat" from_id="user:daa3f9cd-504b-46fc-8d19-6211d23c9585" chat="7" chat_kind="dm" msg="msg:m-9" at="2026-09-05 12:00">
  <![CDATA[帮我看下登录页]]>
</gugu_delivery>`;
    const me: SelfIdentity = { userId: 'daa3f9cd-504b-46fc-8d19-6211d23c9585', displayName: '老板', guguNumber: 7 };
    // A:没有本地 profile(独立打开的会话页)⇒ 信封没带 from,只能显示 from_id —— owner 看到的那一格。
    const withoutSelf = await mount(SINGLE, false, OWN);
    expect(withoutSelf.sender).toBe('user:daa3f9cd-504b-46fc-8d19-6211d23c9585');
    // B:本地 profile 在 ⇒ 是我。
    const withSelf = await mount(SINGLE, false, OWN, (item) => item, me);
    expect(withSelf.sender).toBe('You');
    // 阴性对照:别人的信封(from_id 不是我)不受本地 profile 影响。
    const other = await mount(SINGLE, false, ENVELOPE, (item) => item, me);
    expect(other.sender).toBe('Alice');
    // 认得出是我就够了,profile 里有没有名字、号都一样。
    expect((await mount(SINGLE, false, OWN, (item) => item, { ...me, displayName: null, guguNumber: null })).sender).toBe('You');
  });

  // #6822 08-25 那种嵌套写法没有结构化事实:照样成卡,没有「详情」。
  // #6835 悄悄话与 App 代发标在来路那一句上(手机与桌面同一张卡);详情里各多一行。
  it('marks a whisper and an app-sent delivery in the route line and the details', async () => {
    const whisper = ENVELOPE.replace('chat_kind="group"', 'chat_kind="group" whisper_to="user:kip" via_app="app:werewolf"');
    const closed = await mount(SINGLE, false, whisper);
    expect(closed.route).toBe('from app app:werewolf · whisper · via a group');
    const plain = await mount(SINGLE, false, ENVELOPE);
    expect(plain.route).toBe('via a group');
    const open = await mount(SINGLE, true, whisper);
    const plainOpen = await mount(SINGLE, true, ENVELOPE);
    expect(open.computed).toBe(open.dom);
    expect(open.factRows).toBe(plainOpen.factRows + 2);
  });

  // 来路那句写 App 的名字(宿主按装着的 App、界面语言给);这台没有那个 App 就写信封里的 id。
  it('names the App in the route line when the host knows it, and keeps the id when it does not', async () => {
    const viaApp = ENVELOPE.replace('chat_kind="group"', 'chat_kind="group" via_app="app:werewolf"');
    const named = (appId: string) => (appId === 'app:werewolf' ? '狼人杀' : null);
    const known = await mount(SINGLE, false, viaApp, (item) => item, null, () => null, () => {}, false, named);
    expect(known.route).toBe('from app 狼人杀 · via a group');
    const unknown = await mount(SINGLE, false, viaApp, (item) => item, null, () => null, () => {}, false, () => null);
    expect(unknown.route).toBe('from app app:werewolf · via a group');
  });

  // 信封里的 chat 是群号(给 agent 寻址),人读群名:宿主按来源链接里的对话 id 认得这个群就写名字,认不得只说「来自群聊」,❌ 写群号。
  it('names the group in the route line when the host knows it, and never shows its number', async () => {
    const linked = ENVELOPE.replace('chat_kind="group"', 'chat_kind="group" source_link="gugu-chat://3f2a9c1e-0000-4000-8000-000000000007/5b0c0e1d-0000-4000-8000-000000000001"');
    const named = (chatId: string) => (chatId === '3f2a9c1e-0000-4000-8000-000000000007' ? '设计评审' : null);
    const known = await mount(SINGLE, false, linked, (item) => item, null, () => null, () => {}, false, () => null, named);
    expect(known.route).toBe('via group 设计评审');
    const unknown = await mount(SINGLE, false, linked, (item) => item, null, () => null, () => {}, false, () => null, () => null);
    expect(unknown.route).toBe('via a group');
  });

  it('legacy nested envelope still renders as a delivery card, with no details band', async () => {
    const legacy = `<gugu_delivery>
  <gugu_instruction><source_message_id>m-1</source_message_id></gugu_instruction>
  <gugu_body><![CDATA[Use the legacy body exactly]]></gugu_body>
</gugu_delivery>`;
    const r = await mount(SINGLE, true, legacy);
    expect(r.computed).toBe(r.dom);
    expect(r.sender).toBe('Delivered via 咕咕');
    expect(r.route).toBeNull();
    expect(r.factsShown).toBe(false);
    expect(r.bodyText).toContain('Use the legacy body exactly');
  });
});

// #6306 头像投影宿主给的真实头像:同一个身份与聊天页同一张图;没有身份 / 还不知道 ⇒ 不画,位置保留。
describe('delivery card avatar (#6306)', () => {
  const FACE = 'data:image/svg+xml;utf8,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2218%22 height=%2218%22/%3E';
  const SESSION = `<gugu_delivery route="session-direct" from="Build bot" from_id="session:s-1" msg="msg:m-3" at="2026-09-23 12:00">
  <![CDATA[done]]>
</gugu_delivery>`;

  it('draws the image the host resolves for that sender, and asks with the envelope from_id', async () => {
    const asked: Array<string | null> = [];
    const r = await mount(SINGLE, false, ENVELOPE, (item) => item, null, (fromId) => {
      asked.push(fromId);
      return fromId === 'user:alice' ? FACE : null;
    });
    expect(asked).toContain('user:alice');
    expect(r.avatar).toEqual({ state: 'image', src: FACE, width: 18 });
    expect(r.computed).toBe(r.dom);
  });

  it('a sender with no identity (session:) gets no avatar — only the name', async () => {
    const r = await mount(SINGLE, false, SESSION, (item) => item, null, (fromId) => (fromId?.startsWith('user:') ? FACE : null));
    expect(r.avatar).toEqual({ state: 'empty', src: null, width: 18 });
    expect(r.sender).toBe('Build bot');
  });

  // #6593 咕咕自己发来的通知(比如主人改了 agent 的名字):来路写「来自咕咕」,❌ 退回成「来自聊天」。
  it('a 咕咕 system notice is labelled as coming from 咕咕, not a chat, and gets no avatar', async () => {
    const SYSTEM = `<gugu_delivery route="system" from="咕咕系统" from_id="system:gugu" msg="msg:m-6593" at="2026-09-27 03:00">
  <![CDATA[Your owner renamed you.]]>
</gugu_delivery>`;
    const r = await mount(SINGLE, false, SYSTEM, (item) => item, null, (fromId) => (fromId?.startsWith('user:') ? FACE : null));
    expect(r.route).toBe('from 咕咕');
    expect(r.sender).toBe('咕咕系统');
    expect(r.avatar.state).toBe('empty');
  });

  it('a sender learned later fills the slot once, without moving the card', async () => {
    const [known, setKnown] = createSignal(false);
    const resolver = (fromId: string | null) => (known() && fromId === 'user:alice' ? FACE : null);
    const before = await mount(SINGLE, false, ENVELOPE, (item) => item, null, resolver);
    expect(before.avatar.state).toBe('empty');
    setKnown(false);
    const after = await mount(SINGLE, false, ENVELOPE, (item) => item, null, resolver, () => setKnown(true));
    expect(after.avatar).toEqual({ state: 'image', src: FACE, width: 18 });
    expect(after.dom).toBe(before.dom);
    expect(after.computed).toBe(after.dom);
  });
});
