/** @jsxImportSource solid-js */
/**
 * 计划审批卡（#7139）的契约：ExitPlanMode 画成一张通知卡（计划是 markdown，选项在卡底），
 * 不再是一行原始 JSON；选项答的是会话那条待批请求；量高与真实 DOM 一致。
 *
 * 选项与请求取自 claude-agent-acp 1.4.0 `permissions/options/tools.js` 的 `buildExitPlanModePermissionOptions`
 * （mac1 实例实测的就是这五项，10-15）。
 */
import { SEGMENTERS } from '@session-chat/components/engine/unit-registry';
import {
  planReviewFromItem,
  planReviewUnitDef,
  type PlanReview,
} from '@session-chat/components/rows/tools/plan-review/plan-review.def';
import type { SegmentCtx } from '@session-chat/core/units';
import { defaultChatTranslator } from '@session-chat/localization';
import type { AcpPermissionRequest, ToolNode } from '@session-chat/model';
import { toolRunCategory } from '@session-chat/state/tool-run';
import { describe, expect, it } from 'vitest';
import { makeContractCtx, renderAndMeasureUnit } from './contract';

type Unknown = Extract<ToolNode, { kind: 'unknown-tool-call' }>;

const PLAN = '# Plan: create notes.txt\n\n## Steps\n1. Write `notes.txt` with `hello`\n2. Read it back';

function exitPlan(status: Unknown['status'], over: Partial<Unknown> = {}): Unknown {
  return {
    kind: 'unknown-tool-call',
    id: 't1:tool:toolu_1',
    seq: 0,
    toolCallId: 'toolu_1',
    title: 'Approve Plan',
    toolName: 'ExitPlanMode',
    name: 'Approve Plan',
    toolKind: 'switch_mode',
    status,
    rawInput: JSON.stringify({ plan: PLAN, planFilePath: '/Users/x/.claude/plans/p.md' }, null, 2),
    ...over,
  };
}

const REQUEST: AcpPermissionRequest = {
  requestId: 'req-1',
  toolCall: exitPlan('running'),
  options: [
    { optionId: 'exit-plan-clear-auto', name: 'Yes, clear context (0% used) and use auto mode', kind: 'allow_always' },
    { optionId: 'exit-plan-auto', name: 'Yes, and use auto mode', kind: 'allow_always' },
    { optionId: 'exit-plan-bypass', name: 'Yes, and bypass permissions', kind: 'allow_always' },
    { optionId: 'exit-plan-default', name: 'Yes, manually approve edits', kind: 'allow_once' },
    { optionId: 'reject', name: 'No, keep planning', kind: 'reject_once' },
  ],
};

function segCtx(pending: AcpPermissionRequest[] = []): SegmentCtx {
  return {
    caches: {} as SegmentCtx['caches'],
    expanded: () => false,
    active: true,
    plan: () => null,
    translate: defaultChatTranslator,
    pendingToolCallIds: () => new Set(pending.flatMap((request) => request.toolCall ? [request.toolCall.toolCallId] : [])),
    permissionFor: (id) => pending.find((request) => request.toolCall?.toolCallId === id),
    terminalSnapshot: () => null,
  };
}

describe('计划审批走计划卡，不走通用工具行', () => {
  it('ExitPlanMode 分到 plan-review；别的未知工具照旧是 tool', () => {
    const seg = SEGMENTERS['unknown-tool-call'];
    expect(seg.segment(exitPlan('running'), segCtx([REQUEST])).map((u) => u.kind)).toEqual(['plan-review']);
    // 阴控：只换工具名。
    const other = exitPlan('running', { toolName: 'EnterPlanMode', title: 'EnterPlanMode', name: 'EnterPlanMode' });
    expect(seg.segment(other, segCtx()).map((u) => u.kind)).toEqual(['tool']);
  });

  it('状态只读会话现有的请求与工具状态', () => {
    const state = (item: Unknown, pending: AcpPermissionRequest[] = []) => planReviewFromItem(item, segCtx(pending)).state;
    expect(state(exitPlan('running'), [REQUEST])).toBe('awaiting');
    expect(state(exitPlan('done'))).toBe('approved');
    expect(state(exitPlan('error'))).toBe('rejected');
    expect(state(exitPlan('running'))).toBe('open');
    expect(planReviewFromItem(exitPlan('running'), segCtx()).text).toBe(PLAN);
  });

  it('选项：按计划开始在最上、不批在最下，用咕咕的话；认不得的 id 照用适配器原文', () => {
    const extra = { optionId: 'exit-plan-next', name: 'Yes, and something new', kind: 'allow_always' };
    const { options } = planReviewFromItem(exitPlan('running'), segCtx([{ ...REQUEST, options: [...REQUEST.options, extra] }]));
    expect(options.map((option) => option.optionId)).toEqual([
      'exit-plan-default',
      'exit-plan-clear-auto',
      'exit-plan-auto',
      'exit-plan-bypass',
      'exit-plan-next',
      'reject',
    ]);
    expect(options[0].label).toBe(defaultChatTranslator('transcript.planStart'));
    expect(options[4].label).toBe('Yes, and something new');
  });

  it('不并进「用了 N 个工具」那一组', () => {
    expect(toolRunCategory(exitPlan('done'))).toBeNull();
    expect(toolRunCategory(exitPlan('done', { toolName: 'Skill', title: 'Skill', name: 'Skill' }))).toBe('tool');
  });
});

const awaiting = (): PlanReview => planReviewFromItem(exitPlan('running'), segCtx([REQUEST]));

async function read(data: PlanReview, opts: { width?: number; resolve?: boolean; click?: string } = {}) {
  const calls: Array<{ requestId: string; optionId: string }> = [];
  let text = '';
  const reading = await renderAndMeasureUnit(
    planReviewUnitDef,
    data,
    makeContractCtx({ width: opts.width ?? 640 }),
    (host) => {
      // 看得见的三块（读屏用的隐藏文字不算）。
      text = ['header', 'body', 'footer']
        .map((slot) => host.querySelector(`[data-slot="hook-notice-${slot}"]`)?.textContent ?? '')
        .join(' | ');
      const buttons = [...host.querySelectorAll<HTMLButtonElement>('button[data-option-id]')];
      if (opts.click) host.querySelector<HTMLButtonElement>(`button[data-option-id="${opts.click}"]`)?.click();
      const rects = buttons.map((b) => b.getBoundingClientRect());
      // 卡底的高是量出来的、写死在样式上 ⇒ 量错了卡不会跟着变，只会裁掉或空出一截：读最后一颗的底边离卡底多远。
      const footer = host.querySelector<HTMLElement>('[data-slot="hook-notice-footer"]');
      const last = rects.at(-1);
      return {
        options: buttons.length,
        disabled: buttons.filter((b) => b.disabled).length,
        // 一颗一行：没有哪颗和上一颗叠在同一行。
        overlaps: rects.filter((r, k) => k > 0 && r.top < rects[k - 1].bottom).length,
        footerGap: footer && last ? Math.round(footer.getBoundingClientRect().bottom - last.bottom) : 0,
        // 按钮框在卡里，字也得在按钮里（字溢出按钮不改按钮的框）。
        textSpill: Math.max(0, ...buttons.map((b) => b.scrollWidth - b.clientWidth)),
        tallest: Math.max(0, ...rects.map((rect) => Math.round(rect.height))),
        // 实心的颗数（人该点的那颗才有底色）。
        filled: buttons.filter((b) => getComputedStyle(b).backgroundColor !== 'rgba(0, 0, 0, 0)').length,
      };
    },
    opts.resolve === false ? {} : { onResolvePermission: ({ requestId, optionId }) => calls.push({ requestId, optionId }) }
  );
  return { ...reading, text, calls };
}

describe('计划卡画出来的样子', () => {
  it('等批准：计划按 markdown 画，五个选项一颗一行，点了答的是那条请求', async () => {
    const r = await read(awaiting(), { click: 'exit-plan-default' });
    expect(r.text).toContain('Plan: create notes.txt');
    expect(r.text).toContain('Write notes.txt with hello');
    // 不再是原始 JSON。
    expect(r.text).not.toContain('"plan"');
    expect(r.text).not.toContain('# Plan');
    expect(r.text).toContain(defaultChatTranslator('transcript.planStartClearAuto'));
    expect(r.text).not.toContain('Yes, manually approve edits');
    expect(r.inspected.options).toBe(5);
    expect(r.inspected.overlaps).toBe(0);
    expect(r.inspected.filled, '只有「按计划开始」那一颗实心').toBe(1);
    expect(r.calls).toEqual([{ requestId: 'req-1', optionId: 'exit-plan-default' }]);
    expect(r.inspected.footerGap, '卡底量的高与选项实际的高不符（负 = 最后一颗被裁）').toBe(0);
    expect(r.dom, `measure()=${r.computed} 与 DOM=${r.dom}`).toBe(r.computed);
  });

  // 会话栏最窄一格 220（MIN_PANE_WIDTH_PX），卡比栏窄 —— 选项折行，不出卡；高度跟着量。
  it('窄：选项折行、不出卡，量高照样对', async () => {
    const wide = await read(awaiting());
    for (const width of [300, 236, 156]) {
      const r = await read(awaiting(), { width });
      expect(r.spill, `${width}：选项出了卡 ${r.spill}px`).toBeLessThanOrEqual(0);
      expect(r.inspected.textSpill, `${width}：字出了按钮`).toBe(0);
      expect(r.inspected.footerGap, `${width}：卡底量的高与选项实际的高不符`).toBe(0);
      expect(r.dom, `${width}：measure()=${r.computed} 与 DOM=${r.dom}`).toBe(r.computed);
      // 阳控：最窄这格真有选项折了行（读按钮自己的高，不读整卡 —— 正文窄了也会多折）。
      if (width === 156) expect(r.inspected.tallest).toBeGreaterThan(wide.inspected.tallest);
    }
  });

  it('宿主没接回调：卡照画，选项置灰', async () => {
    const r = await read(awaiting(), { resolve: false, click: 'exit-plan-default' });
    expect(r.inspected.options).toBe(5);
    expect(r.inspected.disabled).toBe(5);
    expect(r.calls).toEqual([]);
    expect(r.dom).toBe(r.computed);
  });

  it('批了 / 没批：头写结果，卡底没有选项', async () => {
    for (const [status, key] of [['done', 'transcript.planApproved'], ['error', 'transcript.planRejected']] as const) {
      const r = await read(planReviewFromItem(exitPlan(status), segCtx()));
      expect(r.text).toContain(defaultChatTranslator(key));
      expect(r.text).toContain('Plan: create notes.txt');
      expect(r.inspected.options).toBe(0);
      expect(r.dom).toBe(r.computed);
    }
  });
});

// 别家的计划审批（#7139），形状取自读源码与 qwen 实测：同一张卡、同一张选项表，不按家分支。
const T = defaultChatTranslator;
const option = (optionId: string, name: string, kind: string) => ({ optionId, name, kind });

// qwen-code 0.22.3：工具名在 `_meta.toolName`；流里那一行的 rawInput 由运行时从请求补上（见 cell.ts fillToolCall）。
const qwenItem = exitPlan('running', { toolName: 'exit_plan_mode', title: 'ExitPlanMode', name: 'ExitPlanMode', rawInput: JSON.stringify({ plan: PLAN }) });
const QWEN: AcpPermissionRequest = {
  requestId: 'req-qwen',
  toolCall: qwenItem,
  options: [
    option('restore_previous', 'Yes, restore previous mode (auto)', 'allow_once'),
    option('proceed_always', 'Yes, and auto-accept edits', 'allow_always'),
    option('proceed_once', 'Yes, and manually approve edits', 'allow_once'),
    option('cancel', 'No, keep planning (esc)', 'reject_once'),
  ],
};

// qoder 1.1.71：工具名在 `_meta.qoder.toolName`，标题是一句话，计划只在请求的正文里（运行时补成这一行的 outputText）。
const qoderItem = exitPlan('running', { toolName: 'ExitPlanMode', title: 'Ready to start implementation?', name: 'Ready', rawInput: '{}', outputText: PLAN });
const QODER: AcpPermissionRequest = {
  requestId: 'req-qoder',
  toolCall: qoderItem,
  options: [
    option('default', 'Yes, and manually approve edits', 'allow_once'),
    option('acceptEdits', 'Yes, and auto-accept edits', 'allow_always'),
    option('yolo', 'Yes, and bypass permissions', 'allow_always'),
    option('plan', 'No, keep planning', 'reject_once'),
  ],
};

describe('别家的计划审批：同一张卡', () => {
  it('分到计划卡；选项用同一张表里咕咕的话', () => {
    expect(SEGMENTERS['unknown-tool-call'].segment(qwenItem, segCtx([QWEN])).map((u) => u.kind)).toEqual(['plan-review']);
    const qwen = planReviewFromItem(qwenItem, segCtx([QWEN]));
    expect(qwen.text).toBe(PLAN);
    expect(qwen.options.map((o) => o.label)).toEqual([
      T('transcript.planStartRestore'),
      T('transcript.planStart'),
      T('transcript.planStartAcceptEdits'),
      T('transcript.planKeepPlanning'),
    ]);
    const qoder = planReviewFromItem(qoderItem, segCtx([QODER]));
    expect(qoder.text, '计划只在正文里').toBe(PLAN);
    expect(qoder.options.map((o) => o.label)).toEqual([
      T('transcript.planStart'),
      T('transcript.planStartAcceptEdits'),
      T('transcript.planStartBypass'),
      T('transcript.planKeepPlanning'),
    ]);
  });

  it('认不得的 id 照用它的 name；name 也空就写 id，❌ 空按钮', () => {
    const odd = { ...QWEN, options: [option('mystery', '', 'allow_always'), option('cancel', 'No', 'reject_once')] };
    expect(planReviewFromItem(qwenItem, segCtx([odd])).options.map((o) => o.label)).toEqual(['mystery', T('transcript.planKeepPlanning')]);
  });

  it('两颗 allow_once（qwen）也只有第一颗实心，计划照画', async () => {
    const r = await read(planReviewFromItem(qwenItem, segCtx([QWEN])));
    expect(r.text).toContain('Plan: create notes.txt');
    expect(r.inspected.options).toBe(4);
    expect(r.inspected.filled).toBe(1);
    expect(r.dom).toBe(r.computed);
  });
});
