import { unit } from '@session-chat/core/units';
import type { ItemSegmenter, SegmentCtx, SegmentItem } from '@session-chat/core/units';
import { defaultChatTranslator } from '@session-chat/localization';
import type { ChatItem, ChatMessage, OpenedOutputItem, TranscriptTurn } from '@session-chat/model';
import { describe, expect, it } from 'vitest';
import { flattenTier } from './flatten';
import { collectOpenedOutputs, openedOutputLook, outputsOfRun } from './opened-outputs';

/**
 * 附件卡(#7193):成功的 open_in_tab 照常是过程里的一步,另在这一轮最后那条回复下面挂一张卡,同一份只挂一张。
 * 判据喂合成的时间线(形状取自真实记录),每条都构造得出必失败的反例。
 */

function passthrough(kind: string): ItemSegmenter {
  return { kind, segment: (item: SegmentItem) => [unit(item.kind, item, item, { key: 'self' })] };
}
const SEGMENTERS: Record<string, ItemSegmenter> = Object.fromEntries(
  ['message', 'mcp-tool-call', 'execute-tool-call', 'turn-outcome', 'turn-process', 'tool-run', 'opened-output'].map((k) => [
    k,
    passthrough(k),
  ])
);

const user = (id: string, text = '做个汇报'): ChatMessage => ({ kind: 'message', id, seq: 0, role: 'user', text });
const reply = (id: string, text = '汇报做好了'): ChatMessage => ({ kind: 'message', id, seq: 0, role: 'assistant', text });
const bash = (id: string): ChatItem =>
  ({ kind: 'execute-tool-call', id, seq: 0, toolCallId: id, title: 'bash', status: 'done', parentToolCallId: null } as unknown as ChatItem);
const open = (
  id: string,
  target: { path?: string; url?: string },
  over: { status?: 'done' | 'error'; parentToolCallId?: string } = {}
): ChatItem =>
  ({
    kind: 'mcp-tool-call',
    id,
    seq: 0,
    toolCallId: id,
    title: 'mcp__gugu__session_open_in_tab',
    server: 'gugu',
    tool: 'session_open_in_tab',
    status: over.status ?? 'done',
    rawInput: JSON.stringify(target),
    outputText: JSON.stringify(over.status === 'error' ? { error: 'not found' } : { opened: true, ...target, intent: 'pinned' }),
    parentToolCallId: over.parentToolCallId ?? null,
  } as unknown as ChatItem);

function turn(id: string, items: ChatItem[], extra: Partial<TranscriptTurn> = {}): TranscriptTurn {
  return {
    id,
    seq: 1,
    initiator: items.some((i) => i.kind === 'message' && (i as ChatMessage).role === 'user') ? 'user' : 'agent',
    items: items as TranscriptTurn['items'],
    outcome: { kind: 'done' },
    ...extra,
  } as TranscriptTurn;
}

const ctx = (extra: Partial<SegmentCtx> = {}): SegmentCtx =>
  ({
    caches: {},
    expanded: () => false,
    active: false,
    plan: () => null,
    translate: defaultChatTranslator,
    pendingToolCallIds: () => new Set<string>(),
    terminalOutputText: () => null,
    terminalExitStatus: () => null,
    foldTurnProcess: true,
    ...extra,
  }) as unknown as SegmentCtx;

const kinds = (units: ReturnType<typeof flattenTier>) => units.map((u) => u.kind);
const cards = (units: ReturnType<typeof flattenTier>) =>
  units.filter((u) => u.kind === 'opened-output').map((u) => (u.data as OpenedOutputItem).output);

describe('flatten:成功的打开挂在这一轮最后', () => {
  it('折起来的一轮:过程收进时间头(打开那一步也在里面),卡片在最后那条回复下面', () => {
    const units = flattenTier(
      [turn('t1', [user('u1'), bash('b1'), open('o1', { path: '/r/report.html' }), bash('b2'), reply('a1')])],
      ctx(),
      SEGMENTERS
    );
    expect(kinds(units)).toEqual(['message', 'turn-process', 'message', 'opened-output']);
    expect(cards(units)).toEqual([{ kind: 'file', path: '/r/report.html' }]);
    // 展开时间头:打开那一步照样在过程里(工作记录),卡片仍在最后 —— 与 Codex 同一个样子
    const expanded = flattenTier(
      [turn('t1', [user('u1'), bash('b1'), open('o1', { path: '/r/report.html' }), bash('b2'), reply('a1')])],
      ctx({ isTurnProcessExpanded: () => true }),
      SEGMENTERS
    );
    expect(expanded.filter((u) => u.kind === 'mcp-tool-call')).toHaveLength(1);
    expect(kinds(expanded).at(-1)).toBe('opened-output');
  });

  it('只打开了东西的一轮:时间头还在,正文照常,卡片独立挂在正文后面(owner 10-15:「被判为最后一条消息了」)', () => {
    const units = flattenTier(
      [turn('t1', [user('u1'), open('o1', { path: '/r/report.html' }), open('o2', { url: 'https://example.com/x' }), reply('a1', '汇报写好了,打开给你看')])],
      ctx(),
      SEGMENTERS
    );
    expect(kinds(units)).toEqual(['message', 'turn-process', 'message', 'opened-output', 'opened-output']);
  });

  it('同一份开了三次只挂一张;网页与文件各一张;顺序按最后一次打开', () => {
    const units = flattenTier(
      [
        turn('t1', [
          user('u1'),
          open('o1', { path: '/r/a.html' }),
          open('o2', { url: 'https://example.com/x' }),
          open('o3', { path: '/r/a.html' }),
          reply('a1'),
        ]),
      ],
      ctx(),
      SEGMENTERS
    );
    expect(cards(units)).toEqual([
      { kind: 'page', url: 'https://example.com/x' },
      { kind: 'file', path: '/r/a.html' },
    ]);
  });

  it('打开失败的那一次留在过程里照普通工具行画,不挂卡', () => {
    const units = flattenTier(
      [turn('t1', [user('u1'), open('o1', { path: '/gone.html' }, { status: 'error' }), reply('a1')])],
      ctx({ isTurnProcessExpanded: () => true }),
      SEGMENTERS
    );
    expect(cards(units)).toEqual([]);
    expect(units.filter((u) => u.kind === 'mcp-tool-call')).toHaveLength(1);
  });

  it('子智能体自己打开的不挂在主对话里', () => {
    const units = flattenTier(
      [turn('t1', [user('u1'), open('o1', { path: '/sub.html' }, { parentToolCallId: 'task-1' }), reply('a1')])],
      ctx(),
      SEGMENTERS
    );
    expect(cards(units)).toEqual([]);
  });

  it('不折的视图(单栏、手机上只画卡的那一块):卡代表那一步,❌ 再画一行工具调用', () => {
    const units = flattenTier(
      [turn('t1', [user('u1'), open('o1', { path: '/r/a.html' }), reply('a1')])],
      ctx({ foldTurnProcess: false }),
      SEGMENTERS
    );
    expect(kinds(units)).toEqual(['message', 'message', 'opened-output']);
  });

  it('回复之后才打开的(「写好了,打开给你」):不在回复下面多一行工具调用,只有卡', () => {
    const units = flattenTier(
      [turn('t1', [user('u1'), bash('b1'), reply('a1', '汇报写好了,打开给你'), open('o1', { path: '/r/a.html' })])],
      ctx(),
      SEGMENTERS
    );
    expect(kinds(units)).toEqual(['message', 'turn-process', 'message', 'opened-output']);
  });

  it('被前一轮并进来的后续轮:它打开的也挂在并成的那一条最后,只挂一组', () => {
    const units = flattenTier(
      [
        turn('t1', [user('u1'), bash('b1'), open('o1', { path: '/r/a.html' })], { startedAt: 1, endedAt: 2 }),
        turn('t2', [bash('b2'), open('o2', { path: '/r/b.html' }), reply('a1')], { startedAt: 2, endedAt: 3 }),
      ],
      ctx(),
      SEGMENTERS
    );
    expect(kinds(units)).toEqual(['message', 'turn-process', 'message', 'opened-output', 'opened-output']);
    expect(cards(units)).toEqual([
      { kind: 'file', path: '/r/a.html' },
      { kind: 'file', path: '/r/b.html' },
    ]);
  });

  it('在跑的一轮:一张卡都不挂 —— 卡是跑完或被停下才交出来的东西', () => {
    const units = flattenTier([turn('t1', [user('u1'), open('o1', { path: '/r/a.html' }), bash('b1')], { outcome: undefined })], ctx({ active: true }), SEGMENTERS);
    expect(cards(units)).toEqual([]);
  });

  it('在跑的一轮不折叠时:打开那一步照普通工具调用显示,❌ 既没卡又把那一步藏掉', () => {
    const units = flattenTier(
      [turn('t1', [user('u1'), open('o1', { path: '/r/a.html' })], { outcome: undefined })],
      ctx({ active: true, foldTurnProcess: false }),
      SEGMENTERS
    );
    expect(kinds(units)).toEqual(['message', 'mcp-tool-call']);
  });

  it('被停下的一轮:结算之后卡照常挂', () => {
    const units = flattenTier(
      [turn('t1', [user('u1'), open('o1', { path: '/r/a.html' }), bash('b1')], { outcome: { kind: 'cancelled' } })],
      ctx(),
      SEGMENTERS
    );
    expect(cards(units)).toEqual([{ kind: 'file', path: '/r/a.html' }]);
  });
});

describe('collectOpenedOutputs / outputsOfRun', () => {
  it('只读:轮本身不动,打开那一步还在轮里', () => {
    const t1 = turn('t1', [user('u1'), open('o1', { path: '/a' }), reply('a1')]);
    expect(collectOpenedOutputs([t1]).map((found) => found.map((e) => e.output))).toEqual([[{ kind: 'file', path: '/a' }]]);
    expect(t1.items).toHaveLength(3);
  });

  it('只看锚和紧跟着被并进来的轮', () => {
    const opened = collectOpenedOutputs([
      turn('t1', [open('o1', { path: '/a' })]),
      turn('t2', [open('o2', { path: '/b' })]),
      turn('t3', [open('o3', { path: '/c' })]),
    ]);
    expect(outputsOfRun(opened, 0, [false, true, false]).map((e) => e.output)).toEqual([
      { kind: 'file', path: '/a' },
      { kind: 'file', path: '/b' },
    ]);
  });
});

describe('openedOutputLook', () => {
  it('文档:文件名与大写扩展名', () => {
    expect(openedOutputLook({ kind: 'file', path: '/Users/a/汇报-10-15.html' })).toEqual({
      name: '汇报-10-15.html',
      kind: 'document',
      extension: 'HTML',
      machineOnly: false,
    });
  });

  it('图片按图片说', () => {
    expect(openedOutputLook({ kind: 'file', path: '/r/截图.PNG' })).toMatchObject({ kind: 'image', extension: 'PNG' });
  });

  it('file:// 打开的网页按文档说', () => {
    expect(openedOutputLook({ kind: 'page', url: 'file:///tmp/r/index.html' }).kind).toBe('document');
  });

  it.each([
    ['http://127.0.0.1:4187/zh/', true],
    ['http://localhost:3000', true],
    ['http://192.168.1.20:8080/a', true],
    ['http://mbp.local/a', true],
    ['https://github.com/nmhjklnm/gugu/pull/1', false],
  ])('网页 %s 只在那台电脑上开得了:%s', (url, machineOnly) => {
    const look = openedOutputLook({ kind: 'page', url });
    expect(look.kind).toBe('page');
    expect(look.machineOnly).toBe(machineOnly);
    expect(look.name.startsWith('http')).toBe(false);
  });
});
