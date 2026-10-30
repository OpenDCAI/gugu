/** @jsxImportSource solid-js */
import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import type { ChatCommands } from '@session-chat/commands';
import { ConversationHoverContext } from '@session-chat/components/contexts/ConversationHoverContext';
import { CommandsContext } from '@session-chat/components/contexts/CommandsContext';
import { ThemeContext } from '@session-chat/components/contexts/ThemeContext';
import { CachesContext } from '@session-chat/components/contexts/CachesContext';
import { SelfIdentityProvider } from '@session-chat/lib/self-identity';
import { ConversationProcess } from './ConversationProcess';
import { createChatCaches } from '@session-chat/core/caches';
import { DEFAULT_CONFIG, buildChatTheme } from '@session-chat/core/config';
import type { MeasureCtx, RenderCtx } from '@session-chat/core/define';
import type { ChatMessage } from '@session-chat/model';
import { messageUnitDef, normalizeMessage } from './message.def';
import { cardFadeOverlay } from './user-message.css';

async function mount(raw: ChatMessage, width = 600, commands: ChatCommands = {}, sibling?: ChatMessage) {
  const item = normalizeMessage(raw);
  const [data, setData] = createSignal(item);
  const [hover, setHover] = createSignal<string | null>(null);
  const theme = buildChatTheme(DEFAULT_CONFIG, { preset: 'double', userGutter: 72, agentConversation: true });
  const caches = createChatCaches();
  const ctx: MeasureCtx = { theme, caches, width, commands: { conversationAgentName: () => 'Codex 11', ...commands }, selfIdentity: { userId: 'owner', displayName: '刘威', guguNumber: 111179 }, isCollapsed: () => false, expanded: () => false };
  const renderCtx: RenderCtx = { measureCtx: () => ctx, viewState: { isCollapsed: () => false } };
  const host = document.createElement('div');
  host.style.width = `${width}px`;
  host.dataset.chatLayout = 'double';
  document.body.append(host);
  const Comp = messageUnitDef.Render;
  const dispose = render(() => <ThemeContext.Provider value={() => theme}><CachesContext.Provider value={caches}>
    <SelfIdentityProvider value={() => ({ userId: 'owner', displayName: '刘威', guguNumber: 111179 })}>
    <CommandsContext.Provider value={() => ({ conversationAgentName: () => 'Codex 11', ...commands })}>
      <ConversationHoverContext.Provider value={{ current: hover, set: setHover }}>
        <Comp data={data()} ctx={renderCtx} vars={messageUnitDef.vars!} />
        {sibling && <Comp data={normalizeMessage(sibling)} ctx={renderCtx} vars={messageUnitDef.vars!} />}
      </ConversationHoverContext.Provider>
    </CommandsContext.Provider></SelfIdentityProvider>
  </CachesContext.Provider></ThemeContext.Provider>, host);
  await document.fonts.ready;
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  return { host, item, ctx, update: (next: ChatMessage) => setData(normalizeMessage(next)), dispose: () => { dispose(); host.remove(); } };
}

describe('agent-centered conversation bubbles', () => {
  it('keeps an authorized system notice visible in a closed zero-step process header', () => {
    const host = document.createElement('div');
    host.style.width = '320px';
    document.body.append(host);
    const text = '消息已保留，助理就绪后回复。';
    const [pending, setPending] = createSignal(true);
    const measureCtx: MeasureCtx = { theme: buildChatTheme(DEFAULT_CONFIG), caches: createChatCaches(), width: 320, isCollapsed: () => false, expanded: () => false };
    const dispose = render(() => <CommandsContext.Provider value={() => ({ conversationProcessNotice: () => pending() ? { id: 'notice', text } : null })}>
      <ConversationProcess measureCtx={() => measureCtx} process={{ id: 'im:notice:process', steps: 0 }} anchorId="p" expanded={false} />
    </CommandsContext.Provider>, host);
    try {
      const header = host.querySelector<HTMLElement>('[data-conversation-process]')!;
      expect(header.textContent).toContain(text);
      expect(header.querySelector('[data-agent-conversation-message="notice"]')?.textContent).toBe(text);
      expect(header.offsetHeight).toBe(22);
      expect(header.getBoundingClientRect().width).toBeLessThanOrEqual(320);
      expect(host.textContent).not.toContain('0 steps');
      setPending(false);
      expect(header.textContent).not.toContain(text);
      expect(header.querySelector('[data-agent-conversation-message="notice"]')).toBeNull();
    } finally { dispose(); host.remove(); }
  });
  it.each([320, 600])('keeps the subject left and incoming agents right at width %s with matching measured geometry', async width => {
    for (const role of ['assistant', 'user'] as const) {
      const view = await mount({ kind: 'message', id: role, role, text: '你好，**一起讨论一下这个计划**。'.repeat(12), at: Date.now(), conversationReply: { itemId: 'source', text: '你好' } }, width);
      try {
        const row = view.host.querySelector<HTMLElement>('[data-agent-conversation-message]')!;
        expect(row.dataset.side).toBe(role === 'assistant' ? 'left' : 'right');
        expect(Math.abs(row.getBoundingClientRect().height - messageUnitDef.measure(view.item, view.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
        const bubble = row.querySelector<HTMLElement>('[data-user-card]')!;
        const name = row.querySelector<HTMLElement>('span[title]')!;
        // Explicit native and IM quotes share the existing header on either side.
        expect(row.querySelectorAll('button[title="你好"]')).toHaveLength(1);
        expect(row.textContent).not.toContain('你好↵');
        expect(bubble.contains(name)).toBe(false);
        // 时间、复制(、编辑)那一行在气泡下面占着位置,鼠标停上去才显出来(设计稿 `.acts{opacity:0}`,owner 10-28)。
        const actions = row.querySelector<HTMLElement>('[data-user-message-actions]')!;
        expect(actions.querySelectorAll('time')).toHaveLength(1);
        expect(getComputedStyle(actions.querySelector('button')!).opacity).toBe('0');
        expect(actions.getBoundingClientRect().top).toBeGreaterThanOrEqual(bubble.getBoundingClientRect().bottom - 1);
        if (role === 'assistant') {
          expect(Math.abs(bubble.getBoundingClientRect().left - row.getBoundingClientRect().left)).toBeLessThanOrEqual(1);
          expect(name.textContent).toBe('Codex 11');
        } else {
          expect(Math.abs(bubble.getBoundingClientRect().right - row.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
          expect(name.textContent).toBe('刘威');
        }
      } finally { view.dispose(); }
    }
  });
  it('folds a long subject bubble with a light fade and a show-all button in its actions row', async () => {
    for (const role of ['user', 'assistant'] as const) {
      const view = await mount({ kind: 'message', id: `long-${role}`, role, text: '这是一条很长的消息，用来验证折叠。\n\n'.repeat(60), at: Date.now() });
      try {
        const bubble = view.host.querySelector<HTMLElement>('[data-user-card]')!;
        const fade = bubble.querySelector<HTMLElement>(`.${cardFadeOverlay}`)!;
        const gradient = getComputedStyle(fade).backgroundImage;
        expect(gradient).toContain('linear-gradient');
        // 淡出色就是气泡自己的底色,❌ 原卡片那层深色。
        expect(gradient).toContain(getComputedStyle(bubble).backgroundColor);
        const expand = view.host.querySelector<HTMLButtonElement>('[data-expand-user-card]')!;
        expect(expand.dataset.expandUserCard).toBe(`long-${role}`);
        expect(expand.textContent).toBe('Show all');
        // 「展开全文」单起一行,在时间那一行上面(0 号图)。
        const actions = view.host.querySelector<HTMLElement>('[data-user-message-actions]')!;
        expect(actions.contains(expand)).toBe(false);
        expect(expand.getBoundingClientRect().bottom).toBeLessThanOrEqual(actions.getBoundingClientRect().top + 1);
        expect(expand.getBoundingClientRect().top).toBeGreaterThanOrEqual(bubble.getBoundingClientRect().bottom - 1);
        if (role === 'assistant') expect(Math.abs(expand.getBoundingClientRect().left - bubble.getBoundingClientRect().left)).toBeLessThanOrEqual(1);
        expect(Math.abs(view.host.getBoundingClientRect().height - messageUnitDef.measure(view.item, view.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
      } finally { view.dispose(); }
    }
  });
  it('has no actions row for a process-only reply without a body', async () => {
    const view = await mount({ kind: 'message', id: 'empty', role: 'assistant', text: '', at: 1000,
      conversationProcess: { id: 'empty:process', startedAt: 1000, endedAt: 5000 } });
    try {
      expect(view.host.querySelector('[data-user-message-actions]')).toBeNull();
      expect(Math.abs(view.host.getBoundingClientRect().height - messageUnitDef.measure(view.item, view.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
    } finally { view.dispose(); }
  });
  it('splits a reply into a name + process head and bubble-only bodies with matching measured heights', async () => {
    const process = { id: 'split:process', startedAt: 1000, endedAt: 9000 };
    const head = await mount({ kind: 'message', id: 'split:head', role: 'assistant', text: '两条都发了', at: 1000, conversationProcess: process, conversationPart: 'head' });
    try {
      expect(head.host.querySelector('span[title]')?.textContent).toBe('Codex 11');
      expect(head.host.querySelector('[data-conversation-process]')).not.toBeNull();
      expect(head.host.querySelector('[data-user-card]')).toBeNull();
      expect(head.host.querySelector('[data-user-message-actions]')).toBeNull();
      expect(Math.abs(head.host.getBoundingClientRect().height - messageUnitDef.measure(head.item, head.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
    } finally { head.dispose(); }
    // 中途的气泡不带时间那一行,收了口那一轮的最后一句才带(设计稿 0 号 tail,owner 10-28);两种都量得和画的一样高。
    const middle = await mount({ kind: 'message', id: 'middle', role: 'assistant', text: '中途汇报：前半段跑完了', at: 1000, conversationPart: 'body', conversationHead: 'split:head' });
    try {
      expect(middle.host.querySelector('[data-user-message-actions]')).toBeNull();
      expect(Math.abs(middle.host.getBoundingClientRect().height - messageUnitDef.measure(middle.item, middle.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
    } finally { middle.dispose(); }
    const body = await mount({ kind: 'message', id: 'split', role: 'assistant', text: '两条都发了', at: 1000, conversationPart: 'body', conversationHead: 'split:head', conversationTail: true });
    try {
      expect(body.host.querySelector('span[title]')).toBeNull();
      expect(body.host.querySelector('[data-conversation-process]')).toBeNull();
      expect(body.host.querySelector('[data-user-card]')?.textContent).toContain('两条都发了');
      expect(body.host.querySelector('[data-user-message-actions] time')).not.toBeNull();
      expect(Math.abs(body.host.getBoundingClientRect().height - messageUnitDef.measure(body.item, body.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
    } finally { body.dispose(); }
  });
  it('shows the incoming sender only, without the quote, delivery chrome or avatars', async () => {
    const view = await mount({ kind: 'message', id: 'delivery', role: 'user', text: '<gugu_delivery route="chat" from="天天" from_id="user:other" chat="group" msg="msg:incoming"><reply_to msg="msg:sent" from_id="user:subject"><![CDATA[天天，你好。]]></reply_to><![CDATA[你好，我在。]]></gugu_delivery>' });
    try {
      const row = view.host.querySelector<HTMLElement>('[data-agent-conversation-message]')!;
      expect(row.textContent).toContain('天天');
      expect(row.textContent).not.toContain('天天，你好。');
      expect(row.querySelectorAll('img')).toHaveLength(0);
      expect(row.textContent).not.toContain('来自');
      expect(row.querySelector('[data-user-card]')?.textContent).toContain('你好，我在。');
    } finally { view.dispose(); }
  });
  it('keeps batched deliveries attributed to their own incoming sender', async () => {
    const raw = ['天天', '小明'].map((name, index) => `<gugu_delivery route="chat" from="${name}" from_id="user:sender-${index}" msg="msg:${index}"><![CDATA[${name}发来的消息]]></gugu_delivery>`).join('\n');
    const view = await mount({ kind: 'message', id: 'batch', role: 'user', text: raw });
    try {
      const rows = [...view.host.querySelectorAll<HTMLElement>('[data-agent-conversation-message]')];
      expect(rows).toHaveLength(2);
      expect(rows.map(row => row.querySelector('span[title]')?.textContent)).toEqual(['天天', '小明']);
      expect(rows.every(row => row.dataset.side === 'right')).toBe(true);
      expect(Math.abs(view.host.getBoundingClientRect().height - messageUnitDef.measure(view.item, view.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
    } finally { view.dispose(); }
  });

  it('keeps the thought-network disclosure without timestamps, above the bubble, without extra row height', async () => {
    const view = await mount({ kind: 'message', id: 'reply', role: 'assistant', text: '你好，我在。', at: 1000,
      conversationProcess: { id: 'turn:process', startedAt: 1000, endedAt: 25000 } });
    try {
      const button = view.host.querySelector<HTMLButtonElement>('[data-conversation-process]')!;
      expect(button.parentElement!.querySelector('time')).toBeNull();
      const bubble = view.host.querySelector('[data-user-card]')!;
      expect(button.textContent).toBe('24s›');
      expect(button.querySelector('svg')).not.toBeNull();
      expect(button.dataset.collapseId).toBe('turn:process');
      expect(button.dataset.collapseAnchor).toBe('reply');
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(button.getAttribute('aria-label')).toContain('Thinking and execution');
      expect(bubble.contains(button)).toBe(false);
      // owner 2026-10-27 原型:过程行在气泡上方 —— 正文在流式长高时,这一行不跟着往下挪。
      expect(button.parentElement!.getBoundingClientRect().bottom).toBeLessThanOrEqual(bubble.getBoundingClientRect().top);
      expect(Math.abs(view.host.getBoundingClientRect().height - messageUnitDef.measure(view.item, view.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
    } finally { view.dispose(); }
  });
  it('writes the step count after the duration on the process line', async () => {
    const view = await mount({ kind: 'message', id: 'counted', role: 'assistant', text: '好了', conversationProcess: { id: 'counted:process', startedAt: 1000, endedAt: 75000, steps: 10 } });
    try {
      expect(view.host.querySelector('[data-conversation-process]')?.textContent).toBe('1m14s · 10 steps›');
    } finally { view.dispose(); }
  });
  it('keeps a zero-body process clock without a disclosure arrow or action', async () => {
    const view = await mount({ kind: 'message', id: 'woken', role: 'assistant', text: 'The completion notice arrived.',
      conversationProcess: { id: 'woken:process', startedAt: 1000, endedAt: 3500, steps: 0, empty: true } });
    try {
      const process = view.host.querySelector<HTMLButtonElement>('[data-conversation-process]')!;
      expect(process.textContent).toBe('2s');
      expect(process.disabled).toBe(true);
      expect(process.hasAttribute('data-collapse-id')).toBe(false);
      expect(process.hasAttribute('aria-expanded')).toBe(false);
      expect(process.querySelector('svg')).not.toBeNull();
    } finally { view.dispose(); }
  });

  it('does not invent a duration for historical replies without both clock boundaries', async () => {
    const view = await mount({ kind: 'message', id: 'historical', role: 'assistant', text: '你好', conversationProcess: { id: 'old:process' } });
    try {
      const button = view.host.querySelector<HTMLButtonElement>('[data-conversation-process]')!;
      expect(button.textContent).toBe('›');
      expect(button.querySelector('svg')).not.toBeNull();
    } finally { view.dispose(); }
  });

  it('shows a live timer above the reply and keeps the process expanded', async () => {
    const view = await mount({ kind: 'message', id: 'live', role: 'assistant', text: '我查一下今天的天气。',
      conversationProcess: { id: 'live:process', live: true, startedAt: Date.now() - 5000 } });
    try {
      const button = view.host.querySelector<HTMLButtonElement>('[data-conversation-process]')!;
      expect(button.getAttribute('aria-expanded')).toBe('true');
      expect(button.textContent).toMatch(/[5-9]s/);
      const before = button.textContent;
      await new Promise(resolve => setTimeout(resolve, 1100));
      expect(button.textContent).not.toBe(before);
      expect(view.host.textContent).not.toContain('已处理');
      expect(Math.abs(view.host.getBoundingClientRect().height - messageUnitDef.measure(view.item, view.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
    } finally { view.dispose(); }
  });

  it('updates the existing bubble in place while keeping its name and brain control', async () => {
    const initial: ChatMessage = { kind: 'message', id: 'stable-reply', role: 'assistant', text: '我现在去查一查。', streaming: true,
      conversationProcess: { id: 'weather:process', live: true, startedAt: Date.now() - 5000 } };
    const view = await mount(initial);
    try {
      const bubble = view.host.querySelector('[data-user-card]')!;
      const brain = view.host.querySelector('[data-conversation-process]')!;
      const name = view.host.querySelector('span[title="Codex 11"]')!;
      view.update({ ...initial, text: '北京今天晴，气温适宜。' });
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      expect(view.host.querySelectorAll('[data-user-card]')).toHaveLength(1);
      expect(view.host.querySelector('[data-user-card]')).toBe(bubble);
      expect(view.host.querySelector('[data-conversation-process]')).toBe(brain);
      expect(bubble.textContent).toContain('北京今天晴');
      expect(bubble.textContent).not.toContain('我现在去查一查');
      expect(name.getBoundingClientRect().bottom).toBeLessThanOrEqual(bubble.getBoundingClientRect().top);
      expect(brain.getBoundingClientRect().bottom).toBeLessThanOrEqual(bubble.getBoundingClientRect().top);
    } finally { view.dispose(); }
  });

  it('shows only the nickname for the owner of an incoming group delivery', async () => {
    const view = await mount({ kind: 'message', id: 'own-delivery', role: 'user', text: '<gugu_delivery route="chat" from="刘威 (咕咕号 111179)" from_id="user:owner" msg="msg:hello"><![CDATA[你好]]></gugu_delivery>' });
    try {
      expect(view.host.querySelector('span[title]')?.textContent).toBe('刘威');
      expect(view.host.textContent).not.toContain('111179');
      expect(view.host.textContent).not.toContain('咕咕号');
    } finally { view.dispose(); }
  });

  it('keeps the quote in the name row and never repeats it on the body', async () => {
    const quote = { itemId: 'src', text: '这是被引用的那条消息，'.repeat(12), from: '小王' };
    const quoted = await mount({ kind: 'message', id: 'send:head', role: 'assistant', text: '', at: Date.now(), conversationPart: 'head', sentReplyTo: 'src', conversationReply: quote,
      conversationProcess: { id: 'send:process', startedAt: 1000, endedAt: 2000 } }, 600, { onConversationReply: () => {} });
    const plain = await mount({ kind: 'message', id: 'call:sent:b', role: 'assistant', text: '答你', at: Date.now(), conversationPart: 'body', conversationReply: quote });
    try {
      const line = quoted.host.querySelector<HTMLElement>('[data-slot="conversation-quote"]')!;
      expect(line.textContent).toContain('小王：');
      expect(line.textContent).toContain('…');
      const row = quoted.host.querySelector<HTMLElement>('[data-agent-conversation-message]')!;
      expect(Math.abs(row.getBoundingClientRect().height - messageUnitDef.measure(quoted.item, quoted.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
      expect(line.parentElement?.textContent).toContain('Codex 11');
      expect(line.parentElement).toBe(row.querySelector('[data-conversation-process]')!.parentElement?.parentElement);
      // 没传 reply_to_message_id ⇒ 不画(❌ 猜)。
      expect(plain.host.querySelector('[data-slot="conversation-quote"]')).toBeNull();
    } finally { quoted.dispose(); plain.dispose(); }
  });
  it.each([false, true])('shows no sender for a quote without a known source (clickable: %s)', async clickable => {
    const view = await mount({ kind: 'message', id: 'reply', role: 'assistant', text: 'answer',
      conversationReply: { itemId: 'source', text: 'original words' } }, 600, clickable ? { onConversationReply: () => {} } : {});
    try {
      const quote = view.host.querySelector<HTMLElement>('[data-slot="conversation-quote"]')!;
      expect(quote.textContent).toBe('original words');
      expect(quote.textContent).not.toContain('刘威');
      expect(Math.abs(view.host.getBoundingClientRect().height - messageUnitDef.measure(view.item, view.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
    } finally { view.dispose(); }
  });

  it.each([
    [{ from: 'Peer' }, 'Peer：original words'],
    [{ fromId: 'user:owner' }, '刘威：original words'],
    [{ self: true }, 'Codex 11：original words'],
  ] as const)('uses known source identity %j for an explicit quote', async (identity, expected) => {
    const view = await mount({ kind: 'message', id: 'reply', role: 'assistant', text: 'answer',
      conversationReply: { itemId: 'source', text: 'original words', ...identity } }, 600, { onConversationReply: () => {} });
    try {
      expect(view.host.querySelector('[data-slot="conversation-quote"]')?.textContent).toBe(expected);
    } finally { view.dispose(); }
  });

  it('clicks the exact quote anchor after a virtual row is reused', async () => {
    const onConversationReply = vi.fn();
    const quoted: ChatMessage = { kind: 'message', id: 'reply', role: 'assistant', text: 'reply', conversationReply: { itemId: 'original-1', text: 'same words' } };
    const view = await mount(quoted, 600, { onConversationReply });
    try {
      view.host.querySelector<HTMLButtonElement>('[data-slot="conversation-quote"]')!.click();
      expect(onConversationReply).toHaveBeenLastCalledWith('original-1');
      view.update({ ...quoted, id: 'reply-2', conversationReply: { itemId: 'original-2', text: 'same words' } });
      view.host.querySelector<HTMLButtonElement>('[data-slot="conversation-quote"]')!.click();
      expect(onConversationReply).toHaveBeenLastCalledWith('original-2');
    } finally { view.dispose(); }
  });
  it('mounts the actual Solid body with current identity and releases recycled row listeners', async () => {
    const targets: Parameters<NonNullable<ChatCommands['onMessageTextMount']>>[0][] = [];
    const cleanups: ReturnType<typeof vi.fn>[] = [];
    const first: ChatMessage = { kind: 'message', id: 'original', role: 'assistant', text: 'same words' };
    const view = await mount(first, 600, { onMessageTextMount: target => {
      targets.push(target);
      const cleanup = vi.fn(); cleanups.push(cleanup); return cleanup;
    } });
    try {
      expect(targets).toHaveLength(1);
      expect(targets[0]!.root.textContent).toBe('same words');
      expect(targets[0]!.sender?.()).toBe('Codex 11');
      expect(targets[0]!.root.querySelector('button')).toBeNull();
      view.update({ ...first, id: 'second', text: 'second words' });
      expect(cleanups[0]).toHaveBeenCalledOnce();
      expect(targets.at(-1)!.message().id).toBe('second');
      expect(targets.at(-1)!.root.textContent).toBe('second words');
    } finally { view.dispose(); }
    expect(cleanups.at(-1)).toHaveBeenCalledOnce();
  });
  it('shows a native user quote in the same header and clicks its exact source link', async () => {
    const onConversationReply = vi.fn();
    const reference = 'gugu-session://task?message=opaque%2FID';
    const view = await mount({ kind: 'message', id: 'reply', role: 'user', text: 'follow up', conversationReply: { itemId: reference, text: 'original words', from: 'Agent', unloaded: true } }, 600, { onConversationReply });
    try {
      const button = view.host.querySelector<HTMLButtonElement>('[data-slot="conversation-quote"]')!;
      expect(button.textContent).toContain('original words');
      expect(view.host.textContent).not.toContain('gugu-session:');
      button.click();
      expect(onConversationReply).toHaveBeenCalledWith(reference);
      expect(Math.abs(view.host.firstElementChild!.getBoundingClientRect().height - messageUnitDef.measure(view.item, view.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
    } finally { view.dispose(); }
  });
  it('truncates narration to 160 characters with the same measured 32px row', async () => {
    const view = await mount({ kind: 'message', id: 'narration', role: 'assistant', text: 'word '.repeat(80), conversationNarration: true });
    try {
      const row = view.host.querySelector<HTMLElement>('[data-conversation-narration]')!;
      expect(row.textContent).toHaveLength(160);
      expect(row.offsetHeight).toBe(32);
      expect(getComputedStyle(row).fontSize).toBe('14px');
      expect(messageUnitDef.measure(view.item, view.ctx, messageUnitDef.vars!)).toBe(32);
    } finally { view.dispose(); }
  });
  it('opens the exact group message when the sender name is clicked', async () => {
    const onOpenSender = vi.fn();
    const chat = '22222222-2222-4222-8222-222222222222';
    const msg = '33333333-3333-4333-8333-333333333333';
    const view = await mount({ kind: 'message', id: 'source', role: 'user', text: `<gugu_delivery route="chat" chat_kind="group" from="Cleo" from_id="user:11111111-1111-4111-8111-111111111111" source_link="gugu-chat://${chat}/${msg}"><![CDATA[hello]]></gugu_delivery>` }, 600, { onOpenSender });
    try {
      const name = view.host.querySelector<HTMLButtonElement>('[data-slot="sender-name-link"]')!;
      expect(name.textContent).toBe('Cleo');
      expect(getComputedStyle(name).cursor).toBe('pointer');
      expect(name.querySelector('svg')).toBeNull();
      name.click();
      expect(onOpenSender).toHaveBeenCalledExactlyOnceWith({ kind: 'chat', chatId: chat, messageId: msg });
    } finally { view.dispose(); }
  });
  it('a sent bubble keeps a single destination inside its bottom while time and copy wait for hover', async () => {
    const view = await mount({ kind: 'message', id: 'call:sent:x', role: 'assistant', text: '完成', at: Date.now(), conversationPart: 'body',
      sentTo: { kind: 'chat', conversationId: null, threadRootId: null, whisper: false } });
    try {
      const actions = view.host.querySelector<HTMLElement>('[data-user-message-actions]')!;
      const note = view.host.querySelector<HTMLElement>('[data-user-card] [data-slot="sent-to"]')!;
      expect(actions.contains(note)).toBe(false);
      expect(note.getBoundingClientRect().width).toBeLessThanOrEqual(180);
      expect(note.textContent?.trim()).toBeTruthy();
      // 整行和「发到」都常亮(MBP 验收 10-28:之前整行被原气泡的 hover 规则藏了,「发到」跟着看不见)。
      expect(getComputedStyle(actions).opacity).toBe('1');
      expect(getComputedStyle(note).opacity).toBe('1');
      expect(getComputedStyle(actions.querySelector('button')!).opacity).toBe('0');
      expect(Math.abs(view.host.getBoundingClientRect().height - messageUnitDef.measure(view.item, view.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
    } finally { view.dispose(); }
  });
});



describe('conversation density', () => {
  it.each([220, 320, 600])('keeps process and identity within the measured header at width %s', async width => {
    const view = await mount({ kind: 'message', id: 'header', role: 'assistant', text: '', conversationPart: 'head',
      conversationProcess: { id: 'p', startedAt: 0, endedAt: 75000, steps: 10 },
      conversationReply: { itemId: 'source', text: '真实来源' } }, width, { conversationAgentName: () => '这是一位名字很长的智能体' });
    try {
      const row = view.host.querySelector<HTMLElement>('[data-agent-conversation-message]')!;
      expect(Math.abs(row.getBoundingClientRect().height - messageUnitDef.measure(view.item, view.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
      const process = row.querySelector<HTMLElement>('[data-conversation-process]')!.getBoundingClientRect();
      expect(process.right).toBeLessThanOrEqual(row.getBoundingClientRect().right + 1);
      expect(process.bottom).toBeLessThanOrEqual(row.getBoundingClientRect().bottom + 1);
      row.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const quote = row.querySelector<HTMLElement>('[data-slot="conversation-quote"]')!;
      const arrow = quote.querySelector('svg')!.getBoundingClientRect();
      expect(arrow.left).toBeGreaterThanOrEqual(quote.getBoundingClientRect().left - 1);
      expect(arrow.right).toBeLessThanOrEqual(quote.getBoundingClientRect().right + 1);
      expect(arrow.right).toBeLessThanOrEqual(row.getBoundingClientRect().right + 1);
    } finally { view.dispose(); }
  });
  it('hides a repeated speaker without leaving header space and retains it for a distant reply', async () => {
    const original: ChatMessage = { kind: 'message', id: 'same', role: 'assistant', text: '继续', conversationPreviousSpeaker: '$agent' };
    const view = await mount(original);
    try {
      expect(view.host.querySelector('span[title="Codex 11"]')).toBeNull();
      expect(Math.abs(view.host.getBoundingClientRect().height - messageUnitDef.measure(view.item, view.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
      view.update({ ...original, conversationReply: { itemId: 'older', text: '前面的消息' } });
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      expect(view.host.querySelector('span[title="Codex 11"]')).not.toBeNull();
      const quote = view.host.querySelector<HTMLButtonElement>('[data-slot="conversation-quote"]')!;
      expect(quote.getBoundingClientRect().width).toBe(14);
    } finally { view.dispose(); }
  });
  it.each([true, false])('reveals the head quote when its body is hovered without changing height (adjacent: %s)', async adjacent => {
    const reveal = vi.fn();
    const head: ChatMessage = { kind: 'message', id: 'head', role: 'assistant', text: '', conversationPart: 'head',
      conversationReplyAdjacent: adjacent, conversationReply: { itemId: 'real-source', text: '原始私聊', from: 'Cleo' } };
    const view = await mount(head, 600, { onConversationReply: reveal }, { kind: 'message', id: 'body', role: 'assistant', text: '回复正文', conversationPart: 'body', conversationHead: 'head', conversationTail: true });
    try {
      const row = view.host.querySelector<HTMLElement>('[data-agent-conversation-message="head"]')!;
      const body = view.host.querySelector<HTMLElement>('[data-agent-conversation-message="body"]')!;
      const quote = row.querySelector<HTMLButtonElement>('[data-slot="conversation-quote"]')!;
      const height = row.getBoundingClientRect().height;
      expect(getComputedStyle(quote).display === 'none').toBe(adjacent);
      expect(getComputedStyle(quote.querySelector('span')!).display).toBe('none');
      expect(getComputedStyle(row.querySelector('[data-slot="conversation-quote-separator"]')!).display).toBe('none');
      const before = quote.getBoundingClientRect();
      const originalPoint = { x: before.left + before.width / 2, y: before.top + before.height / 2 };
      body.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      expect(getComputedStyle(quote).display).not.toBe('none');
      expect(getComputedStyle(quote.querySelector('span')!).display).not.toBe('none');
      expect(row.getBoundingClientRect().height).toBe(height);
      if (!adjacent) expect(document.elementFromPoint(originalPoint.x, originalPoint.y)?.closest('[data-slot="conversation-quote"]')).toBe(quote);
      quote.click();
      expect(reveal).toHaveBeenCalledExactlyOnceWith('real-source');
      body.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (!adjacent) { quote.click(); expect(reveal).toHaveBeenCalledTimes(2); }
    } finally { view.dispose(); }
  });
  it('truncates long destinations inside each bubble and mounts the existing host tooltip with full text', async () => {
    const cleanup = vi.fn();
    const targets: { root: HTMLElement; text: string }[] = [];
    const view = await mount({ kind: 'message', id: 'sent', role: 'assistant', text: '完成', conversationPart: 'body', sentTo:
      { kind: 'chat', conversationId: null, threadRootId: null, whisper: false, peer: '很长的群聊去处'.repeat(12) } }, 320, {
        onTooltipMount: target => { targets.push(target); return cleanup; },
      });
    try {
      const note = view.host.querySelector<HTMLElement>('[data-user-card] [data-slot="sent-to"]')!;
      expect(targets).toHaveLength(1);
      expect(targets[0]!.text).toContain('很长的群聊去处'.repeat(12));
      expect(note.getBoundingClientRect().width).toBe(180);
      expect(getComputedStyle(note).textOverflow).toBe('ellipsis');
      expect(Math.abs(view.host.getBoundingClientRect().height - messageUnitDef.measure(view.item, view.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
    } finally { view.dispose(); }
    expect(cleanup).toHaveBeenCalledOnce();
  });
});


it.each([320, 600])('paints a sent file as the existing left-side attachment card, opens its canonical link and measures it at width %s', async width => {
  const onOpenLink = vi.fn();
  const view = await mount({ kind: 'message', id: 'file:sent:receipt', role: 'assistant', text: 'proof.txt',
    sentAttachment: { messageId: 'receipt', name: 'proof.txt', href: 'gugu-file://proof?v=2' } }, width, { onOpenLink });
  try {
    const row = view.host.querySelector<HTMLElement>('[data-agent-conversation-message]')!;
    const card = row.querySelector<HTMLButtonElement>('[data-attachment-chip]')!;
    expect(row.dataset.side).toBe('left');
    expect(card.dataset.kind).toBe('file');
    expect(card.textContent).toBe('proof.txt');
    expect(row.querySelector('[data-user-card]'), 'an attachment-only send has no empty text bubble').toBeNull();
    expect(Math.abs(row.getBoundingClientRect().height - messageUnitDef.measure(view.item, view.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
    card.click();
    expect(onOpenLink).toHaveBeenCalledWith('gugu-file://proof?v=2');
  } finally { view.dispose(); }
});

it.each([320, 600])('renders an injected original image instead of local-path instructions at width %s', async width => {
  const messageId = '11111111-2222-4333-8444-555555555555';
  const raw: ChatMessage = { kind: 'message', id: 'original-image', role: 'user', text: `<gugu_delivery route="chat" from="Owner" from_id="user:owner" msg="msg:${messageId}" chat="chat" chat_kind="dm"><![CDATA[Look at this\n[Folder file gugu-file://proof?v=2 — instructions]\n[Image attached at local path: /private/agent/image.png]]]></gugu_delivery>` };
  const original = { text: 'Look at this', attachments: [{ id: `gugu-message-file://${messageId}`, name: 'original.png', kind: 'image' as const, href: 'gugu-file://proof?v=2' }] };
  const resolveAttachment = vi.fn(async () => 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=');
  const onOpenLink = vi.fn();
  const view = await mount(normalizeMessage(raw, () => original), width, { resolveAttachment, onOpenLink });
  try {
    await expect.poll(() => view.host.querySelector('[data-attachment-chip] img')?.getAttribute('src')).toContain('data:image/gif');
    const card = view.host.querySelector<HTMLButtonElement>('[data-attachment-chip]')!;
    expect(card.dataset.kind).toBe('image');
    expect(card.textContent).toBe('original.png');
    expect(view.host.textContent).toContain('Look at this');
    expect(view.host.textContent).not.toContain('/private/agent');
    expect(view.host.textContent).not.toContain('Folder file');
    expect(Math.abs(view.host.getBoundingClientRect().height - messageUnitDef.measure(view.item, view.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
    card.click(); expect(onOpenLink).toHaveBeenCalledWith('gugu-file://proof?v=2');
    expect(raw.text).toContain('/private/agent');
  } finally { view.dispose(); }

});


it('reviewer: a collapsed adjacent quote does not leave an empty repeated-speaker header', async () => {
  const base: ChatMessage = { kind: 'message', id: 'same-speaker', role: 'assistant', text: '继续回复', conversationPreviousSpeaker: '$agent' };
  const plain = await mount(base, 600);
  const reply = await mount({ ...base, id: 'same-speaker-reply', conversationReplyAdjacent: true,
    conversationReply: { itemId: 'preceding-message', text: '正上方那条' } }, 600, { onConversationReply: () => {} });
  try {
    const plainRow = plain.host.querySelector<HTMLElement>('[data-agent-conversation-message]')!;
    const replyRow = reply.host.querySelector<HTMLElement>('[data-agent-conversation-message]')!;
    const quote = replyRow.querySelector<HTMLElement>('[data-slot="conversation-quote"]')!;
    expect(getComputedStyle(quote).display).toBe('none');
    const geometry = { plainHeight: plainRow.getBoundingClientRect().height, replyHeight: replyRow.getBoundingClientRect().height };
    console.info('REVIEW1071_COLLAPSED_HEADER', JSON.stringify(geometry));
    expect(geometry.replyHeight, 'collapsed quote must not create a blank header when neither name nor process is shown').toBe(geometry.plainHeight);
  } finally { plain.dispose(); reply.dispose(); }
});

it('reviewer: a sent file without a caption retains exactly one destination', async () => {
  const view = await mount({ kind: 'message', id: 'file:sent:receipt', role: 'assistant', text: 'proof.txt', conversationPart: 'body',
    sentAttachment: { messageId: 'receipt', name: 'proof.txt', href: 'gugu-file://proof?v=2' },
    sentTo: { kind: 'chat', conversationId: null, threadRootId: null, whisper: false, peer: '验收群' } });
  try {
    expect(view.host.querySelector('[data-attachment-chip]')).not.toBeNull();
    const destinations = view.host.querySelectorAll('[data-slot="sent-to"]');
    console.info('REVIEW1071_ATTACHMENT_DESTINATION', JSON.stringify({ destinations: destinations.length, text: view.item.text, attachments: view.item.attachments?.length }));
    expect(destinations.length, 'the new destination placement must cover attachment-only sends too').toBe(1);
  } finally { view.dispose(); }
});

it.each([220, 600])('reveals a repeated speaker\'s adjacent citation without moving the reply at width %s', async width => {
  const onConversationReply = vi.fn();
  const head: ChatMessage = { kind: 'message', id: 'floating:head', role: 'assistant', text: '',
    conversationPart: 'head', conversationPreviousSpeaker: '$agent', conversationReplyAdjacent: true,
    conversationReply: { itemId: 'preceding-message', text: '正上方那条' } };
  const view = await mount(head, width, { onConversationReply }, { kind: 'message', id: 'floating:body', role: 'assistant',
    text: '继续回复', conversationPart: 'body', conversationHead: head.id, conversationTail: true });
  try {
    const rows = view.host.querySelectorAll<HTMLElement>('[data-agent-conversation-message]');
    const headRow = rows[0]!, body = rows[1]!;
    const quote = headRow.querySelector<HTMLButtonElement>('[data-slot="conversation-quote"]')!;
    const before = body.getBoundingClientRect();
    expect(headRow.getBoundingClientRect().height).toBe(0);
    expect(messageUnitDef.measure(view.item, view.ctx, messageUnitDef.vars!)).toBe(0);
    expect(getComputedStyle(quote).display).toBe('none');
    body.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
    expect(getComputedStyle(quote).display).toBe('flex');
    expect(body.getBoundingClientRect().top).toBe(before.top);
    expect(body.getBoundingClientRect().height).toBe(before.height);
    const visible = quote.getBoundingClientRect();
    expect(visible.height).toBe(18);
    expect(visible.bottom).toBeLessThanOrEqual(before.top);
    expect(visible.right).toBeLessThanOrEqual(before.right);
    quote.click();
    expect(onConversationReply).toHaveBeenCalledExactlyOnceWith('preceding-message');
  } finally { view.dispose(); }
});

it.each([
  ['file', undefined], ['image', undefined], ['file', '文件说明'], ['image', '图片说明'],
] as const)('keeps one destination and measured geometry for a sent %s with caption %s', async (kind, caption) => {
  const view = await mount({ kind: 'message', id: `attachment:sent:${kind}`, role: 'assistant', text: 'proof', conversationPart: 'body',
    sentAttachment: { messageId: 'receipt', kind, name: kind === 'image' ? 'proof.png' : 'proof.txt', href: 'gugu-file://proof?v=2', caption },
    sentTo: { kind: 'chat', conversationId: null, threadRootId: null, whisper: false, peer: '很长的目标群名'.repeat(20) } }, 220);
  try {
    expect(view.host.querySelectorAll('[data-attachment-chip]')).toHaveLength(1);
    const destinations = view.host.querySelectorAll<HTMLElement>('[data-slot="sent-to"]');
    expect(destinations).toHaveLength(1);
    expect(destinations[0]!.getBoundingClientRect().width).toBeLessThanOrEqual(180);
    expect(destinations[0]!.getBoundingClientRect().height).toBe(18);
    expect(view.host.querySelectorAll('[data-user-card]')).toHaveLength(caption ? 1 : 0);
    if (!caption) expect(view.host.querySelector('[data-attachment-destination]')?.contains(destinations[0]!)).toBe(true);
    expect(Math.abs(view.host.getBoundingClientRect().height - messageUnitDef.measure(view.item, view.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
  } finally { view.dispose(); }
});
