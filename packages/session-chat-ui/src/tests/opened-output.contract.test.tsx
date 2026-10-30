/** @jsxImportSource solid-js */
/**
 * 附件卡(#7193)的几何与行为契约,真 Chromium。
 *
 * 一轮的几份产出连成一组(owner 10-15 选的 B):组首行上面、组末行下面各留一档,行高常量 ——
 * measure() 与行根同一笔账,所以「measure === offsetHeight」这一条判不出卡里的东西有没有长出框。
 * 真正的读数从卡里面取:名字、说明、右边那枚各自的上下沿都要落在卡里;窄宽度下名字省略在中间、
 * 后缀留着,不顶出卡的右沿。
 */
import { describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import type { ChatCommands } from '@session-chat/commands';
import {
  OPENED_OUTPUT_GAP,
  OPENED_OUTPUT_ROW_H,
  openedOutputUnitDef,
  splitOutputName,
} from '@session-chat/components/rows/opened-output/opened-output.def';
import type { ChatMessage, OpenedOutputItem, TranscriptTurn } from '@session-chat/model';
import { createChatState } from '@session-chat/state/chat-state';
import { until, untilStable } from '../../../../tests/support/awaitCondition';
import { makeContractCtx, renderAndMeasureUnit, type ContractInspector } from './contract';

const only = { index: 0, count: 1 };
const documentCard: OpenedOutputItem = {
  kind: 'opened-output',
  id: 't1:output:file:/r/汇报-10-15.html',
  turnId: 't1',
  output: { kind: 'file', path: '/Users/me/reports/汇报-10-15.html' },
  ...only,
};
const pageCard: OpenedOutputItem = {
  kind: 'opened-output',
  id: 't1:output:page:http://127.0.0.1:4187/zh/',
  turnId: 't1',
  output: { kind: 'page', url: 'http://127.0.0.1:4187/zh/thanks.html' },
  ...only,
};
const imageCard: OpenedOutputItem = {
  kind: 'opened-output',
  id: 't1:output:file:/r/截图.png',
  turnId: 't1',
  output: { kind: 'file', path: '/r/截图.png' },
  ...only,
};
const longCard: OpenedOutputItem = {
  ...documentCard,
  output: { kind: 'file', path: `/r/${'很长的汇报名字'.repeat(8)}结尾.html` },
};

const openable: ChatCommands = { onOpenOutput: () => undefined };
const withMenu: ChatCommands = { onOpenOutput: () => undefined, outputOpenMode: () => '侧边栏', onOutputMenu: () => undefined };
const unavailable: ChatCommands = { ...withMenu, outputUnavailable: () => '只能在那台电脑上打开' };

/** 卡里每一格的上下左右都在卡里。选择器落空时那一格的键缺席 —— 读成 undefined(响亮的失败),❌ 一个看着干净的 0。 */
const insideCard: ContractInspector = (host) => {
  const card = host.querySelector<HTMLElement>('[data-slot="opened-output"]');
  const read: Record<string, number> = { cardCount: card ? 1 : 0 };
  if (!card) return read;
  const box = card.getBoundingClientRect();
  read.cardHeight = box.height;
  for (const slot of ['opened-output-name', 'opened-output-detail', 'opened-output-open', 'opened-output-mode']) {
    const element = card.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    read[`${slot}:overTop`] = box.top - rect.top;
    read[`${slot}:overBottom`] = rect.bottom - box.bottom;
    read[`${slot}:overRight`] = rect.right - box.right;
  }
  read.chevrons = card.querySelectorAll('[data-slot="opened-output-open"]').length;
  read.modeButtons = card.querySelectorAll('[data-slot="opened-output-mode"]').length;
  const tail = card.querySelector<HTMLElement>('[data-slot="opened-output-name"] > span:last-child');
  if (tail) read['tail:overRight'] = tail.getBoundingClientRect().right - box.right;
  return read;
};

describe('opened-output card geometry contract', () => {
  it.each([
    { label: 'document, host has the open-with menu', data: documentCard, commands: withMenu, chevrons: 0, modes: 1 },
    { label: 'page, host has the open-with menu', data: pageCard, commands: withMenu, chevrons: 0, modes: 1 },
    { label: 'image, host opens but has no menu', data: imageCard, commands: openable, chevrons: 1, modes: 0 },
    { label: 'no host action at all', data: documentCard, commands: {}, chevrons: 0, modes: 0 },
    { label: 'this side cannot open it', data: pageCard, commands: unavailable, chevrons: 0, modes: 0 },
  ])('$label: measure === drawn, every cell inside the card', async ({ data, commands, chevrons, modes }) => {
    const reading = await renderAndMeasureUnit(openedOutputUnitDef, data, makeContractCtx({ width: 420 }), insideCard, commands);
    expect(reading.computed).toBe(OPENED_OUTPUT_ROW_H + 2 * OPENED_OUTPUT_GAP);
    expect(reading.dom).toBe(reading.computed);
    expect(reading.inspected.cardCount).toBe(1);
    expect(reading.inspected.cardHeight).toBe(OPENED_OUTPUT_ROW_H);
    expect(reading.inspected.chevrons).toBe(chevrons);
    expect(reading.inspected.modeButtons).toBe(modes);
    for (const [key, value] of Object.entries(reading.inspected)) {
      if (key.includes(':over')) expect(value, key).toBeLessThanOrEqual(0.5);
    }
  });

  it.each([
    { label: 'first of three', index: 0, height: OPENED_OUTPUT_ROW_H + OPENED_OUTPUT_GAP },
    { label: 'middle of three', index: 1, height: OPENED_OUTPUT_ROW_H },
    { label: 'last of three', index: 2, height: OPENED_OUTPUT_ROW_H + OPENED_OUTPUT_GAP },
  ])('a row in a group ($label): measure === drawn, card keeps its row height', async ({ index, height }) => {
    const data = { ...documentCard, index, count: 3 };
    const reading = await renderAndMeasureUnit(openedOutputUnitDef, data, makeContractCtx({ width: 420 }), insideCard, withMenu);
    expect(reading.computed).toBe(height);
    expect(reading.dom).toBe(height);
    expect(reading.inspected.cardHeight).toBe(OPENED_OUTPUT_ROW_H);
  });

  it('a very long name wraps in full at phone width, including its extension', async () => {
    const reading = await renderAndMeasureUnit(openedOutputUnitDef, longCard, makeContractCtx({ width: 240 }), insideCard, withMenu);
    expect(reading.spill).toBeLessThanOrEqual(0.5);
    expect(reading.inspected['opened-output-name:overRight']).toBeLessThanOrEqual(0.5);
    expect(reading.dom).toBe(reading.computed);
    expect(reading.inspected.cardHeight).toBeGreaterThan(OPENED_OUTPUT_ROW_H);
    expect(reading.inspected['opened-output-mode:overRight']).toBeLessThanOrEqual(0.5);
    expect(splitOutputName('codex-参考截图.png', true)).toEqual({ stem: 'codex-参考', tail: '截图.png' });
    expect(splitOutputName('127.0.0.1:4187/zh', false)).toEqual({ stem: '127.0.0.1:4187/zh', tail: '' });
    // 短名字不拆:拆出空主干会在名字前面空一截(10-15 真机窄栏「周报.md」往右缩了)
    expect(splitOutputName('周报.md', true)).toEqual({ stem: '周报.md', tail: '' });
  });
});

const msg = (id: string, role: ChatMessage['role'], text: string): ChatMessage => ({ kind: 'message', id, seq: 0, role, text });
const openCall = (id: string, target: { path?: string; url?: string }) => ({
  kind: 'mcp-tool-call',
  id,
  seq: 0,
  toolCallId: id,
  title: 'mcp__gugu__session_open_in_tab',
  server: 'gugu',
  tool: 'session_open_in_tab',
  status: 'done',
  rawInput: JSON.stringify(target),
  outputText: JSON.stringify({ opened: true, ...target, intent: 'pinned' }),
  parentToolCallId: null,
});
const TURN: TranscriptTurn = {
  id: 't1',
  seq: 1,
  initiator: 'user',
  startedAt: 1_000,
  endedAt: 61_000,
  items: [
    msg('u1', 'user', '把今天的调研做成一页汇报'),
    msg('a-mid', 'assistant', '先把资料整理一下。'),
    openCall('o1', { path: '/Users/me/reports/汇报-10-15.html' }),
    openCall('o2', { url: 'https://github.com/nmhjklnm/gugu/issues/7193' }),
    msg('a-final', 'assistant', '汇报做好了,已经在右边打开。'),
  ] as TranscriptTurn['items'],
  outcome: { kind: 'done' },
};

describe('opened-output cards on a mounted ChatView', () => {
  it('sit under the final reply as one group; a row click opens the default way, the mode button only opens the menu', async () => {
    const onOpenOutput = vi.fn();
    const onOutputMenu = vi.fn();
    await page.viewport(1000, 800);
    const ctx = createChatContext();
    ctx.setLayout({ preset: 'double', userGutter: 72 });
    const state = createChatState(ctx);
    state.transcript.history.seed([TURN]);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:720px;height:520px;';
    document.body.appendChild(host);
    const view = createChatView({
      context: ctx,
      state,
      parent: host,
      commands: { onOpenOutput, onOutputMenu, outputOpenMode: () => '侧边栏' },
    });
    const cards = () => Array.from(host.querySelectorAll<HTMLElement>('[data-slot="opened-output"]'));
    try {
      await until('cards mount', () => cards().length, (n) => n === 2);
      await untilStable('rows settle', () => {
        const canvas = host.querySelector<HTMLElement>('[data-chat-canvas]');
        return [canvas?.childElementCount ?? -1, canvas?.offsetHeight ?? -1];
      });
      const finalReply = Array.from(host.querySelectorAll<HTMLElement>('[data-chat-canvas] > *')).find((row) =>
        row.textContent?.includes('汇报做好了')
      );
      expect(finalReply, 'final reply row').toBeDefined();
      // 两张卡都在最后那条回复下面
      for (const card of cards()) {
        expect(card.getBoundingClientRect().top).toBeGreaterThanOrEqual(finalReply!.getBoundingClientRect().bottom - 0.5);
      }
      expect(cards().map((card) => card.dataset.outputKind)).toEqual(['document', 'page']);
      expect(cards()[0]!.textContent).toContain('汇报-10-15.html');

      await page.screenshot({ element: host, path: '__screenshots__/opened-output-cards.png' });
      // 一组:首行有上圆角那条边、末行有下圆角,中间不留缝
      expect(cards()[0]!.hasAttribute('data-first')).toBe(true);
      expect(cards()[1]!.hasAttribute('data-last')).toBe(true);
      expect(cards()[1]!.getBoundingClientRect().top - cards()[0]!.getBoundingClientRect().bottom).toBeLessThanOrEqual(0.5);
      // 手机宽度下同一组:名字省略,右边那枚仍在卡里
      host.style.width = '390px';
      await untilStable('rows settle at phone width', () => cards().map((card) => card.getBoundingClientRect().width));
      for (const card of cards()) expect(card.getBoundingClientRect().right).toBeLessThanOrEqual(390.5);
      await page.screenshot({ element: host, path: '__screenshots__/opened-output-cards-phone.png' });

      const mode = cards()[0]!.querySelector<HTMLElement>('[data-slot="opened-output-mode"]')!;
      expect(mode.textContent).toContain('侧边栏');
      mode.click();
      expect(onOutputMenu).toHaveBeenCalledWith(expect.objectContaining({ anchor: mode }));
      // 阴控:点「侧边栏 ▾」只弹菜单,❌ 同时按默认方式打开
      expect(onOpenOutput).not.toHaveBeenCalled();

      cards()[0]!.click();
      expect(onOpenOutput).toHaveBeenCalledWith(
        expect.objectContaining({ output: { kind: 'file', path: '/Users/me/reports/汇报-10-15.html' } })
      );
      cards()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(onOpenOutput).toHaveBeenLastCalledWith(
        expect.objectContaining({ output: { kind: 'page', url: 'https://github.com/nmhjklnm/gugu/issues/7193' } })
      );
    } finally {
      view.dispose();
      host.remove();
    }
  });

  // #7305(owner 10-16 截图:停止键亮着,对话最后已经挂出两张卡):卡是这一轮交出来的东西,跑完或被停下才出。
  it('while the turn is still running there is no card; it appears once the turn settles', async () => {
    await page.viewport(1000, 800);
    const ctx = createChatContext();
    ctx.setLayout({ preset: 'double', userGutter: 72 });
    const state = createChatState(ctx);
    const { endedAt: _endedAt, outcome: _outcome, ...running } = TURN;
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:720px;height:520px;';
    document.body.appendChild(host);
    const view = createChatView({ context: ctx, state, parent: host, commands: { onOpenOutput: () => undefined } });
    const cards = () => host.querySelectorAll('[data-slot="opened-output"]').length;
    const canvasText = () => host.querySelector<HTMLElement>('[data-chat-canvas]')?.textContent ?? '';
    try {
      state.transcript.activeTurn.set({ ...running, items: running.items.slice(0, -1) });
      await until('running turn renders', canvasText, (text) => text.includes('先把资料整理一下'));
      await untilStable('running rows settle', () => [host.querySelector('[data-chat-canvas]')?.childElementCount ?? -1, cards()]);
      await page.screenshot({ element: host, path: '__screenshots__/opened-output-running.png' });
      expect(cards(), 'cards while the turn is running').toBe(0);

      // 跑到最后一帧(回复也到了),还没结算:仍然没有卡
      state.transcript.activeTurn.set(running);
      await until('final reply renders', canvasText, (text) => text.includes('汇报做好了'));
      expect(cards(), 'cards on the last frame before settle').toBe(0);
      // 结算走产品那条路:最后一帧留在活动层,对账回来的 seed 把结算好的这一轮放进已提交层(acp-chat-store._refreshHistory)
      state.transcript.history.seed([TURN]);
      await until('cards mount after the turn settles', cards, (n) => n === 2);
      await page.screenshot({ element: host, path: '__screenshots__/opened-output-settled.png' });
    } finally {
      view.dispose();
      host.remove();
    }
  });
});
