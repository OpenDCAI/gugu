/** @jsxImportSource solid-js */
/**
 * Chromium contract for the turn time-header fold (#4874 → #4981) on a live view.
 *
 * Reads, in order: classic shows every row (positive control); switching the
 * shared context to `base` replaces the process rows with one header whose
 * offsetHeight equals measure(); clicking the header re-emits the hidden rows
 * beneath it; the expanded flag lives in ChatState, so a view disposed and
 * re-created against the same state comes back expanded.
 */
import { describe, expect, it } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { turnProcessUnitDef } from '@session-chat/components/rows/turn-process/turn-process.def';
import { createChatCaches } from '@session-chat/core/caches';
import type { MeasureCtx } from '@session-chat/core/define';
import type { ChatMessage, TranscriptTurn } from '@session-chat/model';
import { createChatState } from '@session-chat/state/chat-state';
import { turnProcessId } from '@session-chat/state/flatten';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const canvasRowCount = (host: HTMLElement): number =>
  host.querySelector('[data-chat-canvas]')?.childElementCount ?? 0;

/**
 * 视图落定(#6346):等事实,不数固定帧数。行集合由虚拟列表在调度帧里投影(viewHeight 来自
 * ResizeObserver),折叠/展开还带 200ms 的高度 tween —— 都不是帧数能保证的。等行数与画布高度在连续若干帧里
 * 不再变(字体已由 contract-setup 在所有用例之前加载完,不是这里的变量)。
 * 调用前先等「这次操作已经开始生效」的事实(行数越过阈值 / 头出现),免得在变化开始前就判定稳定。
 */
async function settled(host: HTMLElement): Promise<void> {
  await untilStable('transcript rows settle', () => {
    const canvas = host.querySelector<HTMLElement>('[data-chat-canvas]');
    return [canvas?.childElementCount ?? -1, canvas?.offsetHeight ?? -1];
  });
}

const msg = (id: string, seq: number, role: ChatMessage['role'], text: string): ChatMessage => ({
  kind: 'message',
  id,
  seq,
  role,
  text,
});
// Two intermediate replies are the process; the last reply stays visible.
const TURN: TranscriptTurn = {
  id: 't1',
  seq: 1,
  initiator: 'user',
  items: [
    msg('u1', 0, 'user', 'Refactor the auth module'),
    msg('a-mid-1', 1, 'assistant', 'Let me look at the module first.'),
    msg('a-mid-2', 2, 'assistant', 'Found three call sites; rewriting them now.'),
    msg('a-final', 3, 'assistant', 'Done: the auth module now uses JWT.'),
  ] as TranscriptTurn['items'],
  outcome: { kind: 'done' },
};

// A second turn right after the first: when the first turn folds, the row
// index that held an assistant reply now holds this user prompt, and vice versa
// on unfold — exactly the re-indexing a per-index row component must survive.
const TURN2: TranscriptTurn = {
  id: 't2',
  seq: 2,
  initiator: 'user',
  items: [
    msg('u2', 0, 'user', 'Now add rate limiting.'),
    msg('a-final-2', 1, 'assistant', 'Rate limiting added.'),
  ] as TranscriptTurn['items'],
  outcome: { kind: 'done' },
};

/**
 * #5350：Stop 钩子返回 `additionalContext` 时，模型在钩子之后还会再说一段，于是一轮是
 * 「过程 → 结束语 → 钩子通知 → 新的行动 → 结束」。折叠要以钩子为界切成两段，结束语和
 * 结束都留在外面（owner 2026-09-09：「展示的是结束语和结束这两段文本就行」）。
 */
const HOOK_TURN: TranscriptTurn = {
  id: 't5',
  seq: 1,
  initiator: 'user',
  startedAt: 1_000,
  endedAt: 43_000,
  items: [
    msg('u5', 0, 'user', 'Write hello.txt'),
    msg('a-work', 1, 'assistant', 'Looking at the folder first.'),
    msg('a-real', 2, 'assistant', 'Done: hello.txt now says hi.'),
    // 钩子通知带到达时刻 —— 它就是两段的边界，两个头各写各段的用时（#5350）。
    { ...msg('n5', 3, 'assistant', '**Notice:** Stop says: Uncommitted changes in this repo.'), at: 13_000 },
    msg('a-extra', 4, 'assistant', 'Checked the repo status once more.'),
    msg('a-post', 5, 'assistant', 'Closing out: nothing left to do.'),
  ] as TranscriptTurn['items'],
  outcome: { kind: 'done' },
};

/**
 * Conversation messages and time headers align with the composer; process
 * cards keep their inset. Read the row wrapper and the painted padding so
 * fold/unfold cannot leave a reused row with its previous unit's chrome.
 */
function expectRowChromeFollowsData(host: HTMLElement) {
  const rows = Array.from(host.querySelectorAll<HTMLElement>('[data-chat-canvas] [data-row-inset]'));
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    const conversationRow = row.dataset.rowKind === 'turn-process'
      || (row.dataset.rowKind === 'message' && !row.querySelector('[data-slot="hook-notice"]'));
    const expected = conversationRow ? '0' : '16';
    expect(row.dataset.rowInset, `${row.dataset.rowKind} row inset`).toBe(expected);
    expect(getComputedStyle(row).paddingLeft).toBe(`${expected}px`);
  }
}

describe('settled-turn process fold on a mounted ChatView', () => {
  it('classic shows all rows; base folds them behind a header that expands on click', async () => {
    const ctx = createChatContext();
    const state = createChatState(ctx);
    state.transcript.history.seed([TURN, TURN2]);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    document.body.appendChild(host);
    let view = createChatView({ context: ctx, state, parent: host });
    await until('classic rows mount', () => canvasRowCount(host), (n) => n >= 6);
    await settled(host);

    const canvas = () => host.querySelector('[data-chat-canvas]') as HTMLElement;
    const rowCount = () => canvas().childElementCount;
    const header = () => host.querySelector('[data-slot="turn-process"]') as HTMLElement | null;
    const textOf = () => canvas().textContent ?? '';

    try {
      // Positive control: classic shows all six rows and no header.
      expect(rowCount()).toBe(6);
      expect(header()).toBeNull();
      expect(textOf()).toContain('Let me look at the module first.');
      expectRowChromeFollowsData(host);

      ctx.setLayout({ preset: 'double', userGutter: 72 });
      await until('base layout folds the process behind a header', () => header() != null);
      await settled(host);

      // Folded: prompt, header, final reply, then the second turn's two rows.
      expect(rowCount()).toBe(5);
      const userCards = () => Array.from(host.querySelectorAll('[data-chat-canvas] [data-user-card]'));
      expect(userCards().map((c) => c.getAttribute('data-user-card'))).toEqual(['u1', 'u2']);
      expectRowChromeFollowsData(host);
      const h = header();
      expect(h).not.toBeNull();
      expect(h!.dataset.expanded).toBe('false');
      expect(textOf()).not.toContain('Let me look at the module first.');
      expect(textOf()).toContain('Done: the auth module now uses JWT.');
      // Header geometry contract: measure() === offsetHeight.
      const caches = createChatCaches();
      const mctx: MeasureCtx = {
        theme: ctx.theme,
        width: 640,
        isCollapsed: () => false,
        expanded: () => false,
        caches,
        expandedId: null,
      };
      const item = { kind: 'turn-process' as const, id: turnProcessId('t1'), turnId: 't1' };
      // 回放来的一轮没有时刻 ⇒ 头上不写时间,只写「过程」—— ❌ 不拿现在减一个不存在的起点。
      expect(h!.textContent).toContain('Process');
      expect(h!.textContent).not.toMatch(/\d+s/);
      expect(h!.offsetHeight).toBe(turnProcessUnitDef.measure(item, mctx, turnProcessUnitDef.vars!));
      caches.clearAll();

      // Expand through the real click path (ChatRoot's data-collapse-id delegation).
      (h!.querySelector('[data-collapse-id]') as HTMLElement).click();
      await until('expanded header re-emits the process rows', rowCount, (n) => n >= 7);
      await settled(host);
      expect(rowCount()).toBe(7);
      expect(header()!.dataset.expanded).toBe('true');
      expect(textOf()).toContain('Let me look at the module first.');
      // Rows were re-indexed by the unfold. Every message must still paint by
      // its own role and chrome — never inside the card the row was born with.
      expect(userCards().map((c) => c.getAttribute('data-user-card'))).toEqual(['u1', 'u2']);
      expect(userCards().some((c) => c.textContent?.includes('Done: the auth module'))).toBe(false);
      expectRowChromeFollowsData(host);

      // The flag lives in ChatState: a re-created view comes back expanded.
      view.dispose();
      view = createChatView({ context: ctx, state, parent: host });
      await until('re-created view mounts its rows', () => canvasRowCount(host), (n) => n >= 7);
      await settled(host);
      expect(rowCount()).toBe(7);
      expect(header()!.dataset.expanded).toBe('true');

      // Collapse again, then back to classic: every row returns, header gone.
      (header()!.querySelector('[data-collapse-id]') as HTMLElement).click();
      await until('collapsed header folds the process rows again', rowCount, (n) => n <= 5);
      await settled(host);
      expect(rowCount()).toBe(5);
      expect(userCards().map((c) => c.getAttribute('data-user-card'))).toEqual(['u1', 'u2']);
      expectRowChromeFollowsData(host);
      ctx.setLayout({ preset: 'single', userGutter: 0 });
      await until('classic layout re-emits every row', rowCount, (n) => n >= 6);
      await settled(host);
      expect(rowCount()).toBe(6);
      expect(header()).toBeNull();
      expect(userCards().map((c) => c.getAttribute('data-user-card'))).toEqual(['u1', 'u2']);
      expectRowChromeFollowsData(host);
    } finally {
      view.dispose();
      ctx.dispose();
      state.dispose();
      document.body.removeChild(host);
    }
  });

  it('#5350 钩子劈开的一轮画成两个头:结束语与结束都在外面,点第二个头还原钩子那一段', async () => {
    const ctx = createChatContext({ layout: { preset: 'double', userGutter: 72 } });
    const state = createChatState(ctx);
    state.transcript.history.seed([HOOK_TURN]);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    document.body.appendChild(host);
    const view = createChatView({ context: ctx, state, parent: host });
    await until('hook-split turn rows mount', () => canvasRowCount(host), (n) => n >= 6);
    await settled(host);

    const canvas = () => host.querySelector('[data-chat-canvas]') as HTMLElement;
    const headers = () =>
      Array.from(host.querySelectorAll<HTMLElement>('[data-slot="turn-process"]'));
    const rowKinds = () =>
      Array.from(canvas().querySelectorAll<HTMLElement>('[data-row-kind]')).map(
        (row) => row.dataset.rowKind
      );
    const textOf = () => canvas().textContent ?? '';

    try {
      // 日期分隔 / 提示 / 头 / 结束语 / 头 / 结束(这一轮带时刻,所以它开了一天)。
      expect(rowKinds()).toEqual([
        'day-separator', 'message', 'turn-process', 'message', 'turn-process', 'message',
      ]);
      expect(headers()).toHaveLength(2);
      expect(textOf()).toContain('Done: hello.txt now says hi.');
      expect(textOf()).toContain('Closing out: nothing left to do.');
      // 折进去的:钩子之前的过程、钩子通知本身、以及钩子引发的那一步。
      expect(textOf()).not.toContain('Looking at the folder first.');
      expect(textOf()).not.toContain('Uncommitted changes in this repo.');
      expect(textOf()).not.toContain('Checked the repo status once more.');
      expectRowChromeFollowsData(host);

      // 每个头写自己那一段:1s→13s = 12s、13s→43s = 30s,相加正是整轮 42s。
      expect(headers()[0].textContent).toMatch(/12s/);
      expect(headers()[1].textContent).toMatch(/30s/);

      // 两个头各开各的:点第二个,还原的是钩子那一段,第一段仍然收着。
      (headers()[1].querySelector('[data-collapse-id]') as HTMLElement).click();
      await until('second header re-emits the hook segment', () => rowKinds().length, (n) => n >= 8);
      await settled(host);
      expect(headers()[0].dataset.expanded).toBe('false');
      expect(headers()[1].dataset.expanded).toBe('true');
      expect(rowKinds()).toEqual([
        'day-separator', 'message', 'turn-process', 'message',
        'turn-process', 'message', 'message', 'message',
      ]);
      expect(textOf()).toContain('Uncommitted changes in this repo.');
      expect(textOf()).toContain('Checked the repo status once more.');
      expect(textOf()).not.toContain('Looking at the folder first.');
      expectRowChromeFollowsData(host);
    } finally {
      view.dispose();
      ctx.dispose();
      state.dispose();
      document.body.removeChild(host);
    }
  });

  it('a cancelled turn keeps its process rows in base', async () => {
    const ctx = createChatContext({ layout: { preset: 'double', userGutter: 72 } });
    const state = createChatState(ctx);
    state.transcript.history.seed([{ ...TURN, id: 't2', outcome: { kind: 'cancelled', reason: 'cancelled' } }]);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    document.body.appendChild(host);
    const view = createChatView({ context: ctx, state, parent: host });
    // 「没有头」要有完成事实:turn-outcome 是这一轮的最后一行,它挂上了,这一轮的行就都投影过了。
    await until('cancelled turn rows mount', () => host.querySelector('[data-slot="turn-outcome"]') != null);
    await settled(host);
    try {
      const canvas = host.querySelector('[data-chat-canvas]') as HTMLElement;
      expect(host.querySelector('[data-slot="turn-process"]')).toBeNull();
      expect(host.querySelector('[data-slot="turn-outcome"]')).not.toBeNull();
      expect(canvas.textContent).toContain('Let me look at the module first.');
    } finally {
      view.dispose();
      ctx.dispose();
      state.dispose();
      document.body.removeChild(host);
    }
  });

});

describe('#4981 合并:一轮一轮落进来,和整条重建画得一样(#70 review)', () => {
  // 人问的那一轮没收尾(只想了一下就停了),agent 自己接着干完、开了口。两轮该并成一个头,回复在外面。
  const thought = (id: string, seq: number) => ({ kind: 'thinking', id, seq, text: `Thinking ${id}`, status: 'done' }) as unknown as ChatMessage;
  const ASK: TranscriptTurn = {
    id: 'ask', seq: 1, initiator: 'user', startedAt: 1_000, endedAt: 2_000,
    items: [msg('u-ask', 0, 'user', 'Ship the beta'), thought('th-ask', 1)] as TranscriptTurn['items'],
    outcome: { kind: 'done' },
  };
  const CONT: TranscriptTurn = {
    id: 'cont', seq: 2, initiator: 'agent', startedAt: 2_500, endedAt: 9_000,
    items: [thought('th-cont', 0), msg('a-cont', 1, 'assistant', 'Beta shipped.')] as TranscriptTurn['items'],
    outcome: { kind: 'done' },
  };

  it('后一轮追加进来时并进前一轮的头,❌ 等下次整条重建才跳进去', async () => {
    const ctx = createChatContext({ layout: { preset: 'double', userGutter: 72 } });
    const state = createChatState(ctx);
    state.transcript.history.seed([ASK]);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    document.body.appendChild(host);
    const view = createChatView({ context: ctx, state, parent: host });
    const headers = () => Array.from(host.querySelectorAll('[data-slot="turn-process"]'));
    try {
      await until('the asking turn folds', () => headers().length, (n) => n === 1);
      await settled(host);
      state.transcript.history.append([CONT]);
      await until('the reply lands', () => host.querySelector('[data-chat-canvas]')?.textContent ?? '', (t) => t.includes('Beta shipped.'));
      await settled(host);
      // 整条重建(切 tab、重进)画出来的就是一个头 —— 追加时也得是。
      expect(headers()).toHaveLength(1);
    } finally {
      view.dispose();
      ctx.dispose();
      state.dispose();
      document.body.removeChild(host);
    }
  });
});

describe('#4981 #12 活动层的过程也折', () => {
  /**
   * ⚠️ 中间那条是**必需**的：`planTurnFold` 把最后一条助手消息当作留在外面的最终回复，
   * 只有一条时 process 为空、它按约定返回 null ⇒ 一行都不折。第一版的 fixture 只有一条，
   * 判据判红判得对 —— 是这个 fixture 立不住，不是活动层不折（2026-09-05）。
   */
  const LIVE_STARTED_AT = Date.now() - 16_000;
  const LIVE_TURN: TranscriptTurn = {
    id: 'live-1',
    seq: 9,
    initiator: 'user',
    startedAt: LIVE_STARTED_AT,
    items: [
      msg('lu1', 0, 'user', 'Research the market'),
      msg('la-mid', 1, 'assistant', 'Checking the latest numbers first.'),
      msg('la-mid-2', 2, 'assistant', 'Now cross-checking with the filings.'),
      msg('la-tail', 3, 'assistant', 'Here is what the numbers say.'),
    ] as TranscriptTurn['items'],
  } as TranscriptTurn;

  /**
   * owner 2026-09-06 指着 Codex 定的形状:跑着「已处理 16s」在数、内容摊开;
   * 跑完「已处理 42s ›」收成一条。头是同一条,只是默认开合与文案不同。
   */
  it('活动轮:时间头在数、内容摊开;落定后同一条头收起、写总时长', async () => {
    const ctx = createChatContext({ layout: { preset: 'double', userGutter: 72 } });
    const state = createChatState(ctx);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    document.body.appendChild(host);
    const view = createChatView({ context: ctx, state, parent: host });
    state.transcript.activeTurn.set(LIVE_TURN);
    await until('live turn header mounts', () => host.querySelector('[data-slot="turn-process"]') != null);
    await settled(host);

    const header = () => host.querySelector<HTMLElement>('[data-slot="turn-process"]');
    const canvas = () => host.querySelector('[data-chat-canvas]') as HTMLElement;
    try {
      const h = header();
      expect(h, '活动轮必须有时间头').not.toBeNull();
      expect(h!.dataset.live).toBe('true');
      // 跑着的时候默认摊开:中间那些话在画布上看得见。
      expect(h!.dataset.expanded).toBe('true');
      expect(canvas().textContent ?? '').toContain('Checking the latest numbers first.');
      expect(canvas().textContent ?? '').toContain('Here is what the numbers say.');
      // 头上写的是从这一轮开始到现在过了多久,❌ 不是步数。秒数对不对由 turn-process-fold.test.ts 用固定的 now 钉住 ——
      // 这里读墙钟的话,CI 一忙、时钟一跳就偶尔红(❌ 测试里写墙钟断言)。
      expect(h!.textContent).toMatch(/Worked for (?:\d+m)?\d+s/);
      expect(h!.textContent).not.toMatch(/steps/);
      // 底下摊着内容时「在动」由那些行负责,头只数秒、不带微光(同屏两处一起扫就是闪);
      // 微光回到头上只在它是这一轮唯一动静的时候(见下面「一轮开始了、还什么都没有」)。
      const label = h!.querySelector('[data-slot="collapse-header"] > span') as HTMLElement;
      expect(label.querySelector('[data-shimmer-text]')).toBeNull();
      // 点头:跑着也要收得起来、再点又摊开,箭头跟着转(owner 2026-10-22「怎么点都保持向下」)。
      const chevron = () => h!.querySelector('[data-slot="collapse-header"] > span:last-child') as HTMLElement;
      (h!.querySelector('[data-collapse-id]') as HTMLElement).click();
      await until('live header collapses on click', () => header()?.dataset.expanded, (v) => v === 'false');
      await settled(host);
      expect(canvas().textContent ?? '').not.toContain('Checking the latest numbers first.');
      // 箭头有 150ms 的转动过渡:等它转到「向右」(收起时不带 rotate)。
      await until('chevron turns right', () => getComputedStyle(chevron()).transform, (t) => t === 'none');
      (header()!.querySelector('[data-collapse-id]') as HTMLElement).click();
      await until('live header re-expands on click', () => header()?.dataset.expanded, (v) => v === 'true');
      await settled(host);
      expect(canvas().textContent ?? '').toContain('Checking the latest numbers first.');
      // 高度契约与静息态同源：同一个 def、同一个 measure()。
      const caches = createChatCaches();
      const mctx: MeasureCtx = {
        theme: ctx.theme,
        width: 640,
        isCollapsed: () => false,
        expanded: () => false,
        caches,
        expandedId: null,
      };
      const item = {
        kind: 'turn-process' as const,
        id: turnProcessId(LIVE_TURN.id),
        turnId: LIVE_TURN.id,
        live: true,
        startedAt: LIVE_STARTED_AT,
      };
      expect(h!.offsetHeight).toBe(turnProcessUnitDef.measure(item, mctx, turnProcessUnitDef.vars!));
      caches.clearAll();

      // 阴控：同样的内容落定进已提交层 ⇒ 同一条头，但不再微光。只改「还在不在跑」
      // 这一个自由度，其余一字不动。
      state.transcript.activeTurn.set(null);
      state.transcript.history.seed([
        { ...LIVE_TURN, endedAt: LIVE_STARTED_AT + 42_000, outcome: { kind: 'done' } } as TranscriptTurn,
      ]);
      await until('committed turn header stops being live', () => header()?.dataset.live, (live) => live === 'false');
      await settled(host);
      const settledHeader = header();
      expect(settledHeader, '落定后仍然要有时间头').not.toBeNull();
      expect(settledHeader!.dataset.live).toBe('false');
      // 落定后默认收起,中间的话进了头后面;头上写总时长。
      expect(settledHeader!.dataset.expanded).toBe('false');
      expect(canvas().textContent ?? '').not.toContain('Checking the latest numbers first.');
      expect(canvas().textContent ?? '').toContain('Here is what the numbers say.');
      expect(settledHeader!.textContent).toContain('Took 42s');
      const settledLabel = settledHeader!.querySelector(
        '[data-slot="collapse-header"] > span'
      ) as HTMLElement;
      expect(settledLabel.querySelector('[data-shimmer-text]')).toBeNull();
    } finally {
      view.dispose();
      ctx.dispose();
      state.dispose();
      document.body.removeChild(host);
    }
  });
});

/**
 * owner 10-07:发出去以后上游首字节常常要几十秒,那段时间里转录里只有用户那一句。这一轮的头从那一刻就在
 * (`pendingTurnHeader`),两种视图都是;双栏里思考一到就落在同一个头下面,单栏里第一行内容一到它就让位。
 * owner 10-23:还没有可折的过程时头是占位 ——「正在思考…」、不数秒;过程到了同一个头才写「已处理 Ns」。
 */
describe('一轮开始了、还没有可折的过程:头占位', () => {
  const STARTED_AT = Date.now() - 7_000;
  const ONLY_PROMPT: TranscriptTurn = {
    id: 'pending-1',
    seq: 3,
    initiator: 'user',
    startedAt: STARTED_AT,
    items: [msg('pu1', 0, 'user', 'Work out 89 times 64')] as TranscriptTurn['items'],
  } as TranscriptTurn;
  const thinking = {
    kind: 'thinking', id: 'pth1', seq: 1, segmentId: 'pth1', text: 'Multiplying first.', status: 'thinking', startedAt: STARTED_AT + 5_000,
  } as TranscriptTurn['items'][number];

  it.each(['double', 'single'] as const)('%s:头占位、带微光、高度与 measure() 一致;思考到了之后', async (preset) => {
    const ctx = createChatContext({ layout: { preset, userGutter: 0 } });
    const state = createChatState(ctx);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    document.body.appendChild(host);
    const view = createChatView({ context: ctx, state, parent: host });
    const header = () => host.querySelector<HTMLElement>('[data-slot="turn-process"]');
    const thinkingRow = () => host.querySelector('[data-row-kind="thinking"]');
    try {
      state.transcript.activeTurn.set(ONLY_PROMPT);
      await until('pending turn header mounts', () => header() != null);
      await settled(host);
      const h = header()!;
      expect(h.dataset.live).toBe('true');
      expect(h.dataset.turnId).toBe(ONLY_PROMPT.id);
      expect(h.textContent).toContain('Thinking…');
      expect(h.textContent).not.toMatch(/\d/);
      const label = h.querySelector('[data-slot="collapse-header"] > span') as HTMLElement;
      expect(label.querySelector('[data-shimmer-text]')).not.toBeNull();
      const mctx: MeasureCtx = { theme: ctx.theme, width: 640, isCollapsed: () => false, expanded: () => false, caches: createChatCaches(), expandedId: null };
      const item = { kind: 'turn-process' as const, id: turnProcessId(ONLY_PROMPT.id), turnId: ONLY_PROMPT.id, live: true };
      expect(h.offsetHeight).toBe(turnProcessUnitDef.measure(item, mctx, turnProcessUnitDef.vars!));

      state.transcript.activeTurn.set({ ...ONLY_PROMPT, items: [...ONLY_PROMPT.items, thinking] } as TranscriptTurn);
      await until('thinking row mounts', () => thinkingRow() != null);
      await settled(host);
      if (preset === 'double') {
        // 同一个头还在,思考落在它下面,头从这一轮的起点数秒
        expect(header()?.dataset.live).toBe('true');
        expect(header()?.textContent).toMatch(/Worked for (?:\d+m)?\d+s/);
        expect((thinkingRow() as HTMLElement).getBoundingClientRect().top).toBeGreaterThan(header()!.getBoundingClientRect().top);
      } else {
        // 单栏不折叠:第一行内容就是动静,头让位
        expect(header()).toBeNull();
      }
    } finally {
      view.dispose();
      ctx.dispose();
      state.dispose();
      document.body.removeChild(host);
    }
  });

  // owner 10-23 真机:agent 先说一句再去干活,头被撤掉,第二句话到了又冒出来(消失 13.7 s)。
  it('先开口再干活:头一直在原处,第二句话之前占位、不带微光,之后数秒', async () => {
    const ctx = createChatContext({ layout: { preset: 'double', userGutter: 0 } });
    const state = createChatState(ctx);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    document.body.appendChild(host);
    const view = createChatView({ context: ctx, state, parent: host });
    const header = () => host.querySelector<HTMLElement>('[data-slot="turn-process"]');
    const shimmering = () => header()?.querySelector('[data-slot="collapse-header"] > span [data-shimmer-text]') != null;
    type Item = TranscriptTurn['items'][number];
    const step = (...rest: Item[]) =>
      state.transcript.activeTurn.set({ ...ONLY_PROMPT, items: [...ONLY_PROMPT.items, ...rest] } as TranscriptTurn);
    const first = msg('pa1', 1, 'assistant', 'Multiplying 89 by 64 first.') as Item;
    try {
      step(first);
      await until('first sentence on screen', () => host.textContent?.includes('Multiplying 89 by 64 first.') ?? false);
      await settled(host);
      const top = header()!.getBoundingClientRect().top;
      expect(header()!.textContent).toContain('Thinking…');
      expect(header()!.textContent).not.toMatch(/\d/);
      expect(shimmering(), '那句话就在头下面,头不再带微光').toBe(false);

      step(first, thinking);
      await until('work arrives under the sentence', () => host.querySelector('[data-row-kind="thinking"]') != null);
      await settled(host);
      expect(header()?.getBoundingClientRect().top).toBe(top);
      expect(header()!.textContent).toContain('Thinking…');

      step(first, thinking, msg('pa2', 2, 'assistant', 'The answer is 5696.') as Item);
      await until('second sentence folds the first', () => header()?.textContent ?? '', (text) => /Worked for (?:\d+m)?\d+s/.test(text));
      await settled(host);
      expect(header()?.getBoundingClientRect().top).toBe(top);
      expect(header()?.dataset.turnId).toBe(ONLY_PROMPT.id);
    } finally {
      view.dispose();
      ctx.dispose();
      state.dispose();
      document.body.removeChild(host);
    }
  });

  it('阴控:落定的一轮只有用户那一句(机器没说它在跑)⇒ 没有头', async () => {
    const ctx = createChatContext({ layout: { preset: 'double', userGutter: 0 } });
    const state = createChatState(ctx);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    document.body.appendChild(host);
    const view = createChatView({ context: ctx, state, parent: host });
    try {
      state.transcript.history.seed([{ ...ONLY_PROMPT, endedAt: STARTED_AT + 1_000, outcome: { kind: 'done' } } as TranscriptTurn]);
      await until('prompt row mounts', () => (host.textContent ?? '').includes('Work out 89 times 64'));
      await settled(host);
      expect(host.querySelector('[data-slot="turn-process"]')).toBeNull();
    } finally {
      view.dispose();
      ctx.dispose();
      state.dispose();
      document.body.removeChild(host);
    }
  });
});
