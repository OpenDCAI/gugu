/** @jsxImportSource solid-js */
import { useTheme } from '@session-chat/components/contexts/ThemeContext';
import { ROW_H } from '@session-chat/components/engine/row-metrics';
import { CollapseHeader } from '@session-chat/components/primitives/CollapseHeader';
import { PreviewWindow } from '@session-chat/components/primitives/PreviewWindow';
import { BlockStackView } from '@session-chat/components/primitives/BlockStackView';
import { proseLinesHeight } from '@session-chat/components/rows/markdown/html/layout';
import type { StackLayout } from '@session-chat/core/compose';
import { type Measured, type MeasureCtx, type RenderCtx } from '@session-chat/core/define';
import { layoutBlockStack } from '@session-chat/core/layout/block-stack';
import type { SegmentCtx } from '@session-chat/core/units';
import { defineUnit } from '@session-chat/core/units';
import { pxTokens } from '@session-chat/styles/px-tokens';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import { Show, createMemo } from 'solid-js';
import type { ChatPlan, PlanEntryPriority, PlanEntryStatus, ToolNode } from '@session-chat/model';
import { useChatTranslator } from '@session-chat/localization';
import { PlanList } from './Plan';
import {
  planProgressFill,
  planProgressTrack,
  planRoot,
  planVars,
  type PlanStyleVars
} from './plan.css';

export type PlanVars = {
  /** Fixed height (px) of the plan header row. */
  rowH: number;
  /** Vertical padding (px) between the header and the entry list, top and bottom. */
  padY: number;
  /** Width (px) of the status-icon box to the left of each entry body. */
  iconBox: number;
  /** Horizontal gap (px) between the status icon and the entry text. */
  iconGap: number;
  /** Vertical gap (px) between consecutive plan entries. */
  entryGap: number;
  /** Maximum height (px) of the collapsed preview window. */
  windowH: number;
  /**
   * 进度条厚度（px）与它与表头之间的间距（#4981 C7）。
   *
   * ⚠️ 两个都必须进 `measure()`：这一行的高度是引擎虚拟滚动坐标的一部分，
   * 任何不进 measure 的高度都会让它下面所有行错位。
   */
  barH: number;
  barGap: number;
};

export function planFromItem(
  item: Extract<ToolNode, { kind: 'create-plan-tool-call' }>,
  ctx: SegmentCtx
): ChatPlan {
  const plan = ctx.plan()?.[item.planId];
  const body = plan?.body;
  return {
    kind: 'plan',
    id: item.id,
    entries: plan?.entries ?? [],
    ...(body?.type === 'markdown' && typeof body.content === 'string' ? { body: { type: 'markdown' as const, content: body.content } } : {}),
    ...(body?.type === 'file' && typeof body.uri === 'string' ? { body: { type: 'file' as const, uri: body.uri } } : {}),
    streaming: item.status === 'running',
  };
}

export type PlanEntryLaid = {
  /** Pre-measured block stack for this entry's content. */
  measured: Measured<StackLayout>;
  status: PlanEntryStatus;
  priority: PlanEntryPriority;
};

/**
 * Total entry indent: icon box + icon gap.
 *
 * This is the only horizontal chrome left. The row used to also subtract the
 * card border and its inner padding; with the card gone the header label and
 * the entry glyphs share the row's own left edge.
 */
function entryIndent(vars: PlanVars): number {
  return vars.iconBox + vars.iconGap;
}

/** Lay out each entry's content into a measured block stack. */
function measureEntries(item: ChatPlan, ctx: MeasureCtx, vars: PlanVars): PlanEntryLaid[] {
  const bodyWidth = ctx.width - entryIndent(vars);
  return item.entries.map((entry, i) => {
    const blocks = ctx.caches.parseBlocks(`${item.id}:e${i}`, entry.content);
    const measured = layoutBlockStack(blocks, { ...ctx, width: bodyWidth }, { padY: 0 });
    return { measured, status: entry.status, priority: entry.priority };
  });
}

function listHeight(entries: PlanEntryLaid[], vars: PlanVars): number {
  const totalEntryH = entries.reduce((sum, e) => sum + e.measured.height, 0);
  const gaps = entries.length > 1 ? (entries.length - 1) * vars.entryGap : 0;
  return totalEntryH + gaps + 2 * vars.padY;
}

function planBodyText(item: ChatPlan): string | undefined {
  return item.body?.type === 'markdown' ? item.body.content : item.body?.type === 'file' ? `[${item.body.uri}](${item.body.uri})` : undefined;
}

function measurePlanBody(item: ChatPlan, ctx: MeasureCtx) {
  const text = planBodyText(item);
  return text === undefined ? undefined : layoutBlockStack(ctx.caches.parseBlocks(`${item.id}:body`, text), ctx, { padY: 0 });
}

/**
 * 进度条占的高度。空计划不画条（没有进度可言），所以它一条目都没有时是 0 ——
 * ❌ 别恒定加上：那会让空计划行凭空高出 5px，而 measure 与渲染各自算一遍就会分叉。
 */
function barHeight(item: ChatPlan, vars: PlanVars): number {
  return item.entries.length > 0 ? vars.barH + vars.barGap : 0;
}

function planMeasure(item: ChatPlan, ctx: MeasureCtx, vars: PlanVars): number {
  const headerH = vars.rowH;
  const isExpanded = ctx.expanded(item.id);
  const entries = measureEntries(item, ctx, vars);
  const body = measurePlanBody(item, ctx);
  const listH = body ? body.height + 2 * vars.padY : listHeight(entries, vars);
  const bodyH = isExpanded ? listH : Math.min(listH, vars.windowH);
  return headerH + barHeight(item, vars) + bodyH;
}

function PlanUnitRender(props: { data: ChatPlan; ctx: RenderCtx; vars: PlanVars }) {
  const theme = useTheme();
  const translate = useChatTranslator();
  const mCtx = () => props.ctx.measureCtx?.();
  // Inverted semantics: stored "collapsed" bool = "expanded".
  const isExpanded = () => props.ctx.viewState.isCollapsed(props.data.id);

  const entries = createMemo(() => {
    const ctx = mCtx();
    if (!ctx) return [];
    return measureEntries(props.data, ctx, props.vars);
  });

  const body = createMemo(() => { const ctx = mCtx(); return ctx ? measurePlanBody(props.data, ctx) : undefined; });
  const listH = createMemo(() => body() ? body()!.height + 2 * props.vars.padY : listHeight(entries(), props.vars));
  const contents = () => <Show when={body()} fallback={<PlanList entries={entries()} />}>{node => <div style={{ padding: `${props.vars.padY}px 0` }}><BlockStackView node={node()} /></div>}</Show>;
  const bodyH = createMemo(() => (isExpanded() ? listH() : Math.min(listH(), props.vars.windowH)));
  // A plan short enough to fit the preview window is already showing all of
  // itself: the collapsed body is `min(listH, windowH)`, so expanding a short
  // list changes nothing the reader can see. Read against the window rather
  // than the current state so the answer survives a toggle.
  const collapsible = createMemo(() => listH() > props.vars.windowH);

  const totalH = createMemo(() => {
    const ctx = mCtx();
    if (!ctx) return props.vars.rowH;
    return planMeasure(props.data, ctx, props.vars);
  });

  const autoScroll = () => !!props.data.streaming;
  const active = () =>
    !!props.data.streaming || props.data.entries.some((e) => e.status === 'in_progress');
  const done = () => props.data.entries.filter((e) => e.status === 'completed').length;
  const total = () => props.data.entries.length;

  const styleVars = (): PlanStyleVars => ({
    height: totalH(),
    padY: props.vars.padY,
    iconBox: props.vars.iconBox,
    iconGap: props.vars.iconGap,
    entryGap: props.vars.entryGap,
    lineH: theme().fonts.body.lineHeight,
    barH: props.vars.barH,
    barGap: props.vars.barGap,
  });

  // 上游 `elements-agent-plan` 的进度读数：已完成 / 总数。
  // ⚠️ 分母为 0 时不画条（见 barHeight），所以这里不必防除零 —— 但仍写成显式判断，
  // 免得下一个人把条子挪出 Show 之后撞上 NaN%。
  const progressPct = () => (total() > 0 ? Math.round((done() / total()) * 100) : 0);

  return (
    <div
      class={planRoot}
      data-slot="agent-plan"
      data-plan-done={done()}
      data-plan-total={total()}
      style={assignInlineVars(planVars, pxTokens(styleVars()))}
    >
      <CollapseHeader
        id={props.data.id}
        collapsible={collapsible()}
        expanded={isExpanded()}
        active={active()}
        height={props.vars.rowH}
      >
        {/* ⚠️ 原文是写死的英文 `Plan {n} out of {m} Tasks done`（#3482 那一批的残留：
            它在 JSX 文本位置上确实有英文字面量，但这个文件当时没被那把尺子扫到）。
            换皮顺手接进 translator —— 在一个正在重画的表头里留着写死的英文，
            比留在原处更糟：下一个人会以为它是有意为之。 */}
        {props.data.body ? translate('transcript.planReview') : translate('transcript.planProgress', { done: done(), total: total() })}
      </CollapseHeader>
      <Show when={total() > 0}>
        <div
          class={planProgressTrack}
          data-slot="agent-plan-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total()}
          aria-valuenow={done()}
        >
          <span class={planProgressFill} style={{ width: `${progressPct()}%` }} />
        </div>
      </Show>
      <Show when={!isExpanded()} fallback={contents()}>
        <PreviewWindow
          height={bodyH()}
          maxH={props.vars.windowH}
          overlay={
            // The fade says "there is more below" — the same promise the chevron
            // makes, in a different shape. It is drawn only when there is.
            collapsible() ? 'fade-bottom' : undefined
          }
          autoScrollBottom={autoScroll()}
          contentHeight={() => listH()}
        >
          {contents()}
        </PreviewWindow>
      </Show>
    </div>
  );
}

export const planUnitDef = defineUnit<ChatPlan, PlanVars>({
  kind: 'plan',
  margin: { top: 8, bottom: 8 },
  vars: {
    rowH: ROW_H,
    padY: 4,
    iconBox: 14,
    iconGap: 8,
    entryGap: 4,
    windowH: 96,
    // 上游是 3px 的细条。厚一点会变成一块色带，把「进度」说成「状态徽记」。
    barH: 3,
    barGap: 2,
  },

  estimate(item, ctx, vars): number {
    const headerH = vars.rowH;
    const isExpanded = ctx.expanded(item.id);
    const entryH = proseLinesHeight(2, ctx.theme);
    const gaps = item.entries.length > 1 ? (item.entries.length - 1) * vars.entryGap : 0;
    const text = planBodyText(item);
    const listH = text === undefined ? item.entries.length * entryH + gaps + 2 * vars.padY : proseLinesHeight(Math.max(1, text.split('\n').length), ctx.theme) + 2 * vars.padY;
    const bodyH = isExpanded ? listH : Math.min(listH, vars.windowH);
    return headerH + barHeight(item, vars) + bodyH;
  },

  measure: planMeasure,

  Render: PlanUnitRender,
});
