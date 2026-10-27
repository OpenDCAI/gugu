/** @jsxImportSource solid-js */
import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { describe, expect, it } from 'vitest';
import { CommandsContext } from '@session-chat/components/contexts/CommandsContext';
import { ThemeContext } from '@session-chat/components/contexts/ThemeContext';
import { CachesContext } from '@session-chat/components/contexts/CachesContext';
import { SelfIdentityProvider } from '@session-chat/lib/self-identity';
import { createChatCaches } from '@session-chat/core/caches';
import { DEFAULT_CONFIG, buildChatTheme } from '@session-chat/core/config';
import type { MeasureCtx, RenderCtx } from '@session-chat/core/define';
import type { ChatMessage } from '@session-chat/model';
import { messageUnitDef, normalizeMessage } from './message.def';

async function mount(raw: ChatMessage, width = 600) {
  const item = normalizeMessage(raw);
  const [data, setData] = createSignal(item);
  const theme = buildChatTheme(DEFAULT_CONFIG, { preset: 'double', userGutter: 72, agentConversation: true });
  const caches = createChatCaches();
  const ctx: MeasureCtx = { theme, caches, width, isCollapsed: () => false, expanded: () => false };
  const renderCtx: RenderCtx = { measureCtx: () => ctx, viewState: { isCollapsed: () => false } };
  const host = document.createElement('div');
  host.style.width = `${width}px`;
  host.dataset.chatLayout = 'double';
  document.body.append(host);
  const Comp = messageUnitDef.Render;
  const dispose = render(() => <ThemeContext.Provider value={() => theme}><CachesContext.Provider value={caches}>
    <SelfIdentityProvider value={() => ({ userId: 'owner', displayName: '刘威', guguNumber: 111179 })}>
    <CommandsContext.Provider value={() => ({ conversationAgentName: () => 'Codex 11' })}>
      <Comp data={data()} ctx={renderCtx} vars={messageUnitDef.vars!} />
    </CommandsContext.Provider></SelfIdentityProvider>
  </CachesContext.Provider></ThemeContext.Provider>, host);
  await document.fonts.ready;
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  return { host, item, ctx, update: (next: ChatMessage) => setData(normalizeMessage(next)), dispose: () => { dispose(); host.remove(); } };
}

describe('agent-centered conversation bubbles', () => {
  it.each([320, 600])('keeps the subject left and incoming agents right at width %s with matching measured geometry', async width => {
    for (const role of ['assistant', 'user'] as const) {
      const view = await mount({ kind: 'message', id: role, role, text: '你好，**一起讨论一下这个计划**。'.repeat(12), at: Date.now(), conversationReply: { itemId: 'source', text: '你好' } }, width);
      try {
        const row = view.host.querySelector<HTMLElement>('[data-agent-conversation-message]')!;
        expect(row.dataset.side).toBe(role === 'assistant' ? 'left' : 'right');
        expect(Math.abs(row.getBoundingClientRect().height - messageUnitDef.measure(view.item, view.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
        const bubble = row.querySelector<HTMLElement>('[data-user-card]')!;
        const name = row.querySelector<HTMLElement>('span[title]')!;
        const quote = row.querySelector<HTMLButtonElement>('button[title="你好"]')!;
        expect(bubble.contains(name)).toBe(false);
        expect(row.querySelectorAll('time')).toHaveLength(0);
        if (role === 'assistant') {
          expect(Math.abs(bubble.getBoundingClientRect().left - row.getBoundingClientRect().left)).toBeLessThanOrEqual(1);
          expect(name.getBoundingClientRect().right).toBeLessThan(quote.getBoundingClientRect().left);
          expect(name.textContent).toBe('Codex 11');
        } else {
          expect(Math.abs(bubble.getBoundingClientRect().right - row.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
          expect(quote.getBoundingClientRect().right).toBeLessThan(name.getBoundingClientRect().left);
          expect(name.textContent).toBe('刘威');
        }
      } finally { view.dispose(); }
    }
  });
  it('shows the incoming sender and quote, without delivery chrome or avatars', async () => {
    const view = await mount({ kind: 'message', id: 'delivery', role: 'user', text: '<gugu_delivery route="chat" from="天天" from_id="user:other" chat="group" msg="msg:incoming"><reply_to msg="msg:sent" from_id="user:subject"><![CDATA[天天，你好。]]></reply_to><![CDATA[你好，我在。]]></gugu_delivery>' });
    try {
      const row = view.host.querySelector<HTMLElement>('[data-agent-conversation-message]')!;
      expect(row.textContent).toContain('天天');
      expect(row.textContent).toContain('天天，你好。');
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

  it('keeps the thought-network disclosure without timestamps, outside the bubble, without extra row height', async () => {
    const view = await mount({ kind: 'message', id: 'reply', role: 'assistant', text: '你好，我在。', at: 1000,
      conversationProcess: { id: 'turn:process', startedAt: 1000, endedAt: 25000 } });
    try {
      const button = view.host.querySelector<HTMLButtonElement>('[data-conversation-process]')!;
      expect(view.host.querySelector('time')).toBeNull();
      const bubble = view.host.querySelector('[data-user-card]')!;
      expect(button.textContent).toBe('24s›');
      expect(button.querySelector('svg')).not.toBeNull();
      expect(button.dataset.collapseId).toBe('turn:process');
      expect(button.dataset.collapseAnchor).toBe('reply');
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(button.getAttribute('aria-label')).toContain('Thinking and execution');
      expect(bubble.contains(button)).toBe(false);
      expect(button.parentElement!.getBoundingClientRect().top).toBeGreaterThanOrEqual(bubble.getBoundingClientRect().bottom);
      expect(Math.abs(view.host.getBoundingClientRect().height - messageUnitDef.measure(view.item, view.ctx, messageUnitDef.vars!))).toBeLessThanOrEqual(1);
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

  it('shows a live brain timer under the reply and keeps the process expanded', async () => {
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
      expect(brain.getBoundingClientRect().top).toBeGreaterThanOrEqual(bubble.getBoundingClientRect().bottom);
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

});
