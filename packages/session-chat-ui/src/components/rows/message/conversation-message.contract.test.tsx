/** @jsxImportSource solid-js */
import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import type { ChatCommands } from '@session-chat/commands';
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

async function mount(raw: ChatMessage, width = 600, commands: ChatCommands = {}, sibling?: ChatMessage, extraCtx: Partial<MeasureCtx> = {}) {
  const item = normalizeMessage(raw);
  const [data, setData] = createSignal(item);
  const theme = buildChatTheme(DEFAULT_CONFIG, { preset: 'double', userGutter: 72, agentConversation: true });
  const caches = createChatCaches();
  const ctx: MeasureCtx = { theme, caches, width, commands: { conversationAgentName: () => 'Codex 11', ...commands }, selfIdentity: { userId: 'owner', displayName: '刘威', guguNumber: 111179 }, isCollapsed: () => false, expanded: () => false, ...extraCtx };
  const renderCtx: RenderCtx = { measureCtx: () => ctx, viewState: { isCollapsed: () => false } };
  const host = document.createElement('div');
  host.style.width = `${width}px`;
  host.dataset.chatLayout = 'double';
  document.body.append(host);
  const Comp = messageUnitDef.Render;
  const dispose = render(() => <ThemeContext.Provider value={() => theme}><CachesContext.Provider value={caches}>
    <SelfIdentityProvider value={() => ({ userId: 'owner', displayName: '刘威', guguNumber: 111179 })}>
    <CommandsContext.Provider value={() => ({ conversationAgentName: () => 'Codex 11', ...commands })}>
        <Comp data={data()} ctx={renderCtx} vars={messageUnitDef.vars!} />
        {sibling && <Comp data={normalizeMessage(sibling)} ctx={renderCtx} vars={messageUnitDef.vars!} />}
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
      const view = await mount({ kind: 'message', id: role, role, text: '你好，**一起讨论一下这个计划**。'.repeat(12), at: Date.now(), sentReplyTo: 'source', conversationReply: { itemId: 'source', text: '你好' } }, width);
      try {
        const row = view.host.querySelector<HTMLElement>('[data-agent-conversation-message]')!;
        expect(row.dataset.side).toBe(role === 'assistant' ? 'left' : 'right');
        expect(Math.abs(row.getBoundingClientRect().height - messageUnitDef.measure(view.item, view.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
        const bubble = row.querySelector<HTMLElement>('[data-user-card]')!;
        const name = row.querySelector<HTMLElement>('span[title]')!;
        // Explicit native and IM quotes share the existing header on either side.
        expect(row.querySelectorAll('[data-slot="conversation-quote"]')).toHaveLength(1);
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

  it('keeps each batched message reference attached to its own explicit reply', async () => {
    const reveal = vi.fn();
    const raw = '<gugu_delivery route="chat" from="Peer" from_id="user:peer" msg="msg:first"><![CDATA[first message]]></gugu_delivery>\n'
      + '<gugu_delivery route="chat" from="Peer" from_id="user:peer" msg="msg:second"><reply_to msg="msg:older" from="Other" from_id="user:other"><![CDATA[original message]]></reply_to><![CDATA[second message]]></gugu_delivery>';
    const view = await mount({ kind: 'message', id: 'batch-replies', role: 'user', text: raw }, 320, { onConversationReply: reveal });
    try {
      const rows = view.host.querySelectorAll('[data-agent-conversation-message]');
      expect(rows[0]!.querySelector('[data-slot="conversation-quote"]')).toBeNull();
      expect(rows[1]!.querySelector('span[title="Peer"]')).toBeNull();
      const arrow = rows[1]!.querySelector<HTMLButtonElement>('[data-slot="conversation-quote"]')!;
      expect(arrow.textContent).toBe('');
      arrow.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
      expect(document.querySelector('[data-slot="conversation-quote-preview"]')?.textContent).toBe('Other：original message');
      arrow.click(); expect(reveal).toHaveBeenCalledExactlyOnceWith('older');
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

  it('keeps only the return mark in the header and never repeats it on the body', async () => {
    const quote = { itemId: 'src', text: '这是被引用的那条消息，'.repeat(12), from: '小王' };
    const quoted = await mount({ kind: 'message', id: 'send:head', role: 'assistant', text: '', at: Date.now(), conversationPart: 'head', sentReplyTo: 'src', conversationReply: quote,
      conversationProcess: { id: 'send:process', startedAt: 1000, endedAt: 2000 } }, 600, { onConversationReply: () => {} });
    const plain = await mount({ kind: 'message', id: 'call:sent:b', role: 'assistant', text: '答你', at: Date.now(), conversationPart: 'body', conversationReply: quote });
    try {
      const line = quoted.host.querySelector<HTMLElement>('[data-slot="conversation-quote"]')!;
      expect(line.textContent).toBe('');
      expect(quoted.host.textContent).not.toContain('小王');
      const row = quoted.host.querySelector<HTMLElement>('[data-agent-conversation-message]')!;
      expect(Math.abs(row.getBoundingClientRect().height - messageUnitDef.measure(quoted.item, quoted.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
      expect(line.parentElement?.parentElement?.textContent).toContain('Codex 11');
      expect(line.parentElement?.parentElement).toBe(row.querySelector('[data-conversation-process]')!.parentElement?.parentElement);
      // 没传 reply_to_message_id ⇒ 不画(❌ 猜)。
      expect(plain.host.querySelector('[data-slot="conversation-quote"]')).toBeNull();
    } finally { quoted.dispose(); plain.dispose(); }
  });
  it.each([false, true])('shows no sender for a quote without a known source (clickable: %s)', async clickable => {
    const view = await mount({ kind: 'message', id: 'reply', role: 'assistant', text: 'answer',
      sentReplyTo: 'source', conversationReply: { itemId: 'source', text: 'original words' } }, 600, clickable ? { onConversationReply: () => {} } : {});
    try {
      const quote = view.host.querySelector<HTMLElement>('[data-slot="conversation-quote"]')!;
      expect(quote.textContent).toBe('');
      expect(view.host.textContent).not.toContain('original words');
      quote.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
      const preview = document.querySelector('[data-slot="conversation-quote-preview"]')!;
      expect(preview.textContent).toBe('original words');
      expect(preview.textContent).not.toContain('刘威');
      expect(Math.abs(view.host.getBoundingClientRect().height - messageUnitDef.measure(view.item, view.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
    } finally { view.dispose(); }
  });

  it.each([
    [{ from: 'Peer' }, 'Peer：original words'],
    [{ fromId: 'user:owner' }, '刘威：original words'],
    [{ self: true }, 'Codex 11：original words'],
  ] as const)('uses known source identity %j for an explicit quote', async (identity, expected) => {
    const view = await mount({ kind: 'message', id: 'reply', role: 'assistant', text: 'answer',
      sentReplyTo: 'source', conversationReply: { itemId: 'source', text: 'original words', ...identity } }, 600, { onConversationReply: () => {} });
    try {
      view.host.querySelector('[data-slot="conversation-quote"]')!.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
      expect(document.querySelector('[data-slot="conversation-quote-preview"]')?.textContent).toBe(expected);
    } finally { view.dispose(); }
  });

  it('clicks the exact quote anchor after a virtual row is reused', async () => {
    const onConversationReply = vi.fn();
    const quoted: ChatMessage = { kind: 'message', id: 'reply', role: 'assistant', text: 'reply', sentReplyTo: 'original-1', conversationReply: { itemId: 'original-1', text: 'same words' } };
    const view = await mount(quoted, 600, { onConversationReply });
    try {
      view.host.querySelector<HTMLButtonElement>('[data-slot="conversation-quote"]')!.click();
      expect(onConversationReply).toHaveBeenLastCalledWith('original-1');
      view.update({ ...quoted, id: 'reply-2', sentReplyTo: 'original-2', conversationReply: { itemId: 'original-2', text: 'same words' } });
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
  it('does not expose a reference for direct model output even when a quote is present', async () => {
    const onConversationReply = vi.fn();
    const reference = 'gugu-session://task?message=opaque%2FID';
    const view = await mount({ kind: 'message', id: 'reply', role: 'assistant', text: 'follow up', conversationReply: { itemId: reference, text: 'original words', from: 'Agent', unloaded: true } }, 600, { onConversationReply });
    try {
      expect(view.host.querySelector('[data-slot="conversation-quote"]')).toBeNull();
      expect(view.host.textContent).not.toContain('original words');
      expect(view.host.textContent).not.toContain('gugu-session:');
      expect(onConversationReply).not.toHaveBeenCalled();
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
      sentReplyTo: 'source', conversationReply: { itemId: 'source', text: '真实来源' } }, width, { conversationAgentName: () => '这是一位名字很长的智能体' });
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
  it('hides a repeated speaker without leaving header space, including a distant reply', async () => {
    const original: ChatMessage = { kind: 'message', id: 'same', role: 'assistant', text: '继续', conversationPreviousSpeaker: '$agent' };
    const view = await mount(original);
    try {
      expect(view.host.querySelector('span[title="Codex 11"]')).toBeNull();
      expect(Math.abs(view.host.getBoundingClientRect().height - messageUnitDef.measure(view.item, view.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
      view.update({ ...original, sentReplyTo: 'older', conversationReply: { itemId: 'older', text: '前面的消息' } });
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      expect(view.host.querySelector('span[title="Codex 11"]')).toBeNull();
      const quote = view.host.querySelector<HTMLButtonElement>('[data-slot="conversation-quote"]')!;
      expect(quote.getBoundingClientRect().width).toBe(18);
    } finally { view.dispose(); }
  });
  it('opens a message preview only on arrow hover, without moving its click target', async () => {
    const reveal = vi.fn();
    const head: ChatMessage = { kind: 'message', id: 'head', role: 'assistant', text: '', conversationPart: 'head', sentReplyTo: 'real-source',
      conversationReply: { itemId: 'real-source', text: '原始私聊', from: 'Cleo' } };
    const view = await mount(head, 600, { onConversationReply: reveal }, { kind: 'message', id: 'body', role: 'assistant', text: '回复正文', conversationPart: 'body', conversationHead: 'head', conversationTail: true });
    try {
      const row = view.host.querySelector<HTMLElement>('[data-agent-conversation-message="head"]')!;
      const body = view.host.querySelector<HTMLElement>('[data-agent-conversation-message="body"]')!;
      const quote = row.querySelector<HTMLButtonElement>('[data-slot="conversation-quote"]')!;
      const before = quote.getBoundingClientRect(), height = row.getBoundingClientRect().height;
      expect(quote.textContent).toBe('');
      expect(document.querySelector('[data-slot="conversation-quote-preview"]')).toBeNull();
      body.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
      expect(document.querySelector('[data-slot="conversation-quote-preview"]')).toBeNull();
      quote.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
      expect(document.querySelector('[data-slot="conversation-quote-preview"]')?.textContent).toBe('Cleo：原始私聊');
      expect(row.getBoundingClientRect().height).toBe(height);
      expect(quote.getBoundingClientRect().left).toBe(before.left);
      expect(document.elementFromPoint(before.left + before.width / 2, before.top + before.height / 2)?.closest('[data-slot="conversation-quote"]')).toBe(quote);
      quote.click(); expect(reveal).toHaveBeenCalledExactlyOnceWith('real-source');
    } finally { view.dispose(); }
  });
  it('opens a touch preview before its source action navigates', async () => {
    const reveal = vi.fn();
    const view = await mount({ kind: 'message', id: 'touch', role: 'assistant', text: '回复', sentReplyTo: 'source',
      conversationReply: { itemId: 'source', text: '触摸原文', from: 'Peer' } }, 320, { onConversationReply: reveal });
    try {
      const quote = view.host.querySelector<HTMLButtonElement>('[data-slot="conversation-quote"]')!;
      quote.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true })); quote.click();
      expect(reveal).not.toHaveBeenCalled();
      const preview = document.querySelector<HTMLDivElement>('[data-slot="conversation-quote-preview"]')!;
      expect(preview.textContent).toBe('Peer：触摸原文');
      preview.querySelector('button')!.click(); expect(reveal).toHaveBeenCalledExactlyOnceWith('source');
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
  const reply = await mount({ ...base, id: 'same-speaker-reply',
    conversationReply: { itemId: 'preceding-message', text: '正上方那条' } }, 600, { onConversationReply: () => {} });
  try {
    const plainRow = plain.host.querySelector<HTMLElement>('[data-agent-conversation-message]')!;
    const replyRow = reply.host.querySelector<HTMLElement>('[data-agent-conversation-message]')!;
    expect(replyRow.querySelector('[data-slot="conversation-quote"]')).toBeNull();
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

it.each([220, 320, 600])('puts a repeated speaker message reference before its process at width %s', async width => {
  const reveal = vi.fn();
  const view = await mount({ kind: 'message', id: 'same:head', role: 'assistant', text: '', conversationPart: 'head',
    conversationPreviousSpeaker: '$agent', sentReplyTo: 'older', conversationReply: { itemId: 'older', text: '旧消息', from: 'Peer' },
    conversationProcess: { id: 'same:process', startedAt: 1000, endedAt: 2000, steps: 1 } }, width, { onConversationReply: reveal });
  try {
    expect(view.host.querySelector('span[title="Codex 11"]')).toBeNull();
    const quote = view.host.querySelector<HTMLButtonElement>('[data-slot="conversation-quote"]')!;
    const process = view.host.querySelector<HTMLElement>('[data-conversation-process]')!;
    expect(quote.textContent).toBe(''); expect(view.host.textContent).not.toContain('旧消息');
    expect(view.host.querySelector('[data-slot="conversation-reference-separator"]')?.textContent).toBe('·');
    expect(quote.getBoundingClientRect().right).toBeLessThan(process.getBoundingClientRect().left);
    expect(process.getBoundingClientRect().right).toBeLessThanOrEqual(view.host.getBoundingClientRect().right + 1);
    expect(Math.abs(view.host.getBoundingClientRect().height - messageUnitDef.measure(view.item, view.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
    quote.click(); expect(reveal).toHaveBeenCalledExactlyOnceWith('older');
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
function assertVisiblePrefix(element: HTMLElement, container: HTMLElement) {
  const node = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
  expect(node, 'text begins in a real painted node').not.toBeNull();
  const range = document.createRange(); range.setStart(node!, 0); range.setEnd(node!, 1);
  const glyph = range.getBoundingClientRect(); let left = container.getBoundingClientRect().left;
  let right = container.getBoundingClientRect().right, top = container.getBoundingClientRect().top, bottom = container.getBoundingClientRect().bottom;
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    const css = getComputedStyle(parent), box = parent.getBoundingClientRect();
    if (/(hidden|clip|auto|scroll)/.test(css.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
    if (/(hidden|clip|auto|scroll)/.test(css.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
    if (parent === container) break;
  }
  expect(glyph.left, 'first glyph is not clipped at the left edge').toBeGreaterThanOrEqual(left - 1);
  expect(glyph.right, 'first glyph is not clipped at the right edge').toBeLessThanOrEqual(right + 1);
  expect(glyph.top, 'first glyph is not clipped at the top').toBeGreaterThanOrEqual(top - 1);
  expect(glyph.bottom, 'first glyph is not clipped at the bottom').toBeLessThanOrEqual(bottom + 1);
  return { prefix: node!.textContent!.slice(0, 6), glyph: { left: glyph.left, right: glyph.right }, visible: { left, right } };
}
it.each([188, 220, 320, 390, 600])('shared name and process prefixes stay visible at width %s', async width => {
  for (const role of ['assistant', 'user'] as const) {
    const raw: ChatMessage = { kind: 'message', id: `prefix-${role}`, role, text: role === 'user'
      ? '<gugu_delivery route="chat" from="这是一位名字非常长的另一位智能体ClaudeXYZ" from_id="user:peer"><![CDATA[hello]]></gugu_delivery>' : '',
      sentReplyTo: 'original', conversationReply: { itemId: 'original', text: 'Original' },
      ...(role === 'assistant' ? { conversationPart: 'head', conversationProcess: { id: 'p', startedAt: 0, endedAt: 75000, steps: 10 } } : {}) };
    const view = await mount(raw, width, { conversationAgentName: () => '这是一位名字非常长的智能体ClaudeXYZ' });
    try {
      const row = view.host.querySelector<HTMLElement>('[data-agent-conversation-message]')!, header = row.firstElementChild as HTMLElement;
      const name = header.querySelector<HTMLElement>('[title]')!;
      assertVisiblePrefix(name, header);
      const arrow = header.querySelector<HTMLElement>('[data-slot="conversation-quote"]')!.getBoundingClientRect();
      const process = header.querySelector<HTMLElement>('[data-conversation-process]');
      if (process) {
        const box = process.getBoundingClientRect();
        expect(Math.abs((arrow.top + arrow.bottom) / 2 - (box.top + box.bottom) / 2), 'arrow shares the process band').toBeLessThanOrEqual(1);
        assertVisiblePrefix(process.querySelector('span')!, header);
      }
    } finally { view.dispose(); }
  }
});
it.each([188, 220, 320, 390, 600])('destination prefix stays visible and capped at width %s', async width => {
  const view = await mount({ kind: 'message', id: 'destination-prefix', role: 'assistant', text: 'Done', conversationPart: 'body',
    sentTo: { kind: 'chat', conversationId: null, threadRootId: null, whisper: false, peer: '非常长的接收群名字'.repeat(20) } }, width);
  try {
    const row = view.host.querySelector<HTMLElement>('[data-agent-conversation-message]')!, target = row.querySelector<HTMLElement>('[data-slot="sent-to"]')!;
    assertVisiblePrefix(target, row);
    expect(target.getBoundingClientRect().width).toBeLessThanOrEqual(180);
    expect(getComputedStyle(target).textOverflow).toBe('ellipsis');
  } finally { view.dispose(); }
});

it.each([188, 220, 320, 600])('keeps a repeated speaker reference in the existing time footer at width %s', async width => {
  for (const source of ['delivery', 'tool', 'native-input'] as const) {
    const reveal = vi.fn(), target = source === 'native-input' ? 'gugu-session://11111111-1111-4111-8111-111111111111?message=original' : 'original';
    const raw: ChatMessage = { kind: 'message', id: `repeat-${source}`, role: source === 'tool' ? 'assistant' : 'user', at: 1700000000000,
      text: source === 'delivery' ? '<gugu_delivery route="chat" from="Peer" from_id="user:peer"><![CDATA[follow-up]]></gugu_delivery>' : 'follow-up',
      conversationPreviousSpeaker: source === 'delivery' ? 'user:peer' : source === 'tool' ? '$agent' : '$owner',
      ...(source === 'tool' ? { sentReplyTo: target } : {}), conversationReply: { itemId: target, text: 'Exact original', from: 'Other' } };
    const view = await mount(raw, width, { onConversationReply: reveal });
    const plain = await mount({ ...raw, conversationReply: undefined, sentReplyTo: undefined }, width);
    try {
      const row = view.host.querySelector<HTMLElement>('[data-agent-conversation-message]')!, footer = row.querySelector<HTMLElement>('[data-user-message-actions]')!;
      const reference = footer.querySelector<HTMLElement>('[data-slot="conversation-reference"]')!, arrow = reference.querySelector<HTMLButtonElement>('button')!;
      expect(row.querySelectorAll('[data-slot="conversation-reference"]')).toHaveLength(1);
      expect(reference).not.toBeNull(); expect(arrow.textContent).toBe('');
      expect(getComputedStyle(reference).opacity).toBe('1'); expect(getComputedStyle(reference).pointerEvents).toBe('auto');
      const box = arrow.getBoundingClientRect(), time = footer.querySelector('time')!.getBoundingClientRect();
      expect(box.top).toBeGreaterThanOrEqual(footer.getBoundingClientRect().top - 1);
      expect(box.bottom).toBeLessThanOrEqual(footer.getBoundingClientRect().bottom + 1);
      expect(Math.abs((box.top + box.bottom) / 2 - (time.top + time.bottom) / 2)).toBeLessThanOrEqual(1);
      expect(row.getBoundingClientRect().height).toBe(plain.host.firstElementChild!.getBoundingClientRect().height);
      expect(Math.abs(row.getBoundingClientRect().height - messageUnitDef.measure(view.item, view.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
      expect(row.textContent).not.toContain('Exact original');
      row.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
      expect(document.querySelector('[data-slot="conversation-quote-preview"]')).toBeNull();
      arrow.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
      expect(document.querySelector('[data-slot="conversation-quote-preview"]')?.textContent).toBe('Other：Exact original');
      arrow.click(); expect(reveal).toHaveBeenCalledExactlyOnceWith(target);
      reference.dispatchEvent(new PointerEvent('pointerleave'));
      arrow.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true })); arrow.click();
      expect(reveal).toHaveBeenCalledTimes(1);
      document.querySelector<HTMLButtonElement>('[data-slot="conversation-quote-preview"] button')!.click();
      expect(reveal).toHaveBeenCalledTimes(2); expect(reveal).toHaveBeenLastCalledWith(target);
    } finally { view.dispose(); plain.dispose(); }
  }
});
it('mounts one host source control and cleans it when the reference moves from name to footer', async () => {
  const cleanup = vi.fn(), mountSource = vi.fn(() => cleanup);
  const raw: ChatMessage = { kind: 'message', id: 'host-reference', role: 'assistant', text: 'follow-up', at: 1700000000000,
    sentReplyTo: 'original', conversationReply: { itemId: 'original', text: 'Original', from: 'Other' } };
  const view = await mount(raw, 320, { onTooltipMount: mountSource, onConversationReply: () => {} });
  try {
    expect(mountSource).toHaveBeenCalledTimes(1);
    view.update({ ...raw, conversationPreviousSpeaker: '$agent' });
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    expect(cleanup).toHaveBeenCalledTimes(1); expect(mountSource).toHaveBeenCalledTimes(2);
    expect(view.host.querySelectorAll('[data-slot="conversation-reference"]')).toHaveLength(1);
    expect(view.host.querySelector('[data-user-message-actions] [data-slot="conversation-reference"]')).not.toBeNull();
  } finally { view.dispose(); }
  expect(cleanup).toHaveBeenCalledTimes(2);
});
it.each([188, 220, 320])('keeps a completed duration and step count on one line before truncating the sender at width %s', async width => {
  const view = await mount({ kind: 'message', id: 'compact-process', role: 'assistant', text: '', conversationPart: 'head',
    conversationProcess: { id: 'compact-process:work', startedAt: 0, endedAt: 6000, steps: 1 },
    sentReplyTo: 'source', conversationReply: { itemId: 'source', text: 'Original' } }, width, { conversationAgentName: () => 'Claude 1 with a deliberately long sender name' });
  try {
    const row = view.host.querySelector<HTMLElement>('[data-agent-conversation-message]')!, header = row.firstElementChild as HTMLElement;
    const process = header.querySelector<HTMLElement>('[data-conversation-process]')!;
    expect(process.getBoundingClientRect().height, 'time and steps are an atomic line').toBe(22);
    expect(header.getBoundingClientRect().height).toBe(28);
    expect(process.textContent).toContain('6s · 1 step');
    expect(process.getBoundingClientRect().right).toBeLessThanOrEqual(row.getBoundingClientRect().right + 1);
    assertVisiblePrefix(header.querySelector<HTMLElement>('[title]')!, header);
  } finally { view.dispose(); }
});

it.each([390, 600])('reserves background controls beside duration before truncating a long name at width %s', async width => {
  const view = await mount({ kind: 'message', id: 'review-background', role: 'assistant', text: '', conversationPart: 'head',
    conversationProcess: { id: 'review-background:work', startedAt: 0, endedAt: 6000, steps: 1 }, sentReplyTo: 'source', conversationReply: { itemId: 'source', text: 'Original' } },
    width, { conversationAgentName: () => 'Claude 1 with a deliberately long sender name '.repeat(3) }, undefined,
    { background: { ownerId: 'review-background', expanded: false, commands: [{ id: 'cmd', launchToolCallId: 'call', taskId: 'bg', name: 'sleep 30' }], subagents: [] } });
  try {
    const process = view.host.querySelector<HTMLElement>('[data-conversation-process]')!.getBoundingClientRect();
    const bg = view.host.querySelector<HTMLElement>('[data-slot="background-tasks-pill"]')!.getBoundingClientRect();
    expect(Math.abs((process.top + process.bottom) / 2 - (bg.top + bg.bottom) / 2), 'background metadata keeps its existing row before the sender takes remaining width').toBeLessThanOrEqual(1);
    expect(view.host.getBoundingClientRect().height).toBe(28);
    expect(bg.right).toBeLessThanOrEqual(view.host.getBoundingClientRect().right + 1);
    expect(Math.abs(view.host.getBoundingClientRect().height - messageUnitDef.measure(view.item, view.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
  } finally { view.dispose(); }
});
