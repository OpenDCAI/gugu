/** @jsxImportSource solid-js */
import { ROW_H } from '@session-chat/components/engine/row-metrics';
import type { MeasureCtx, RenderCtx } from '@session-chat/core/define';
import type { SegmentCtx } from '@session-chat/core/units';
import { defineUnit } from '@session-chat/core/units';
import { pxTokens } from '@session-chat/styles/px-tokens';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import { createMemo } from 'solid-js';
import { toolCallLabel, toolImageUrl } from '@gugu/session-core/acp/client';
import type { ChatToolCall, ToolNode } from '@session-chat/model';
import { deriveToolInputSummary } from '../tool-input-summary';
import { Tool } from './Tool';
import { toolRoot, toolVars, type ToolStyleVars } from './tool.css';
import { toolThumbStrip, type ToolThumbStrip } from './tool-images';
import {
  hasToolPayload,
  layoutToolPayload,
  toolDisclosedResult,
  toolFailureText,
  toolPayloadGeometry,
  type ToolPayloadGeometry,
  type ToolPayloadItem,
} from './tool.layout';

export function toolFromItem(item: ToolNode, ctx: SegmentCtx): ChatToolCall {
  const base = 'toolCallId' in item ? item : null;
  const name =
    item.kind === 'search-tool-call'
      ? ctx.translate('transcript.search')
      : item.kind === 'mcp-tool-call'
        ? ctx.translate('transcript.mcp')
        : item.kind === 'web-fetch-tool-call'
          ? ctx.translate('transcript.fetch')
          : item.kind === 'spawn-subagent-tool-call'
            ? ctx.translate('transcript.subagent')
            : item.kind === 'subagent-done-tool-call'
              ? // 跑成/跑砸写在**行名**里,不写在 status 里 —— status 说的是这次通知本身
                // (到了就是 done),写成 error 会让通用行再打一个 ❌(owner 2026-09-06 否掉)。
                ctx.translate(
                  item.outcome === 'failed'
                    ? 'transcript.subagentFailed'
                    : item.outcome === 'stopped'
                      ? 'transcript.subagentStopped'
                      : 'transcript.subagentDone'
                )
            : item.kind === 'background-command-done-tool-call'
              ? // 后台命令跑完那一行,与上面同一约定(#5117)。
                ctx.translate(
                  item.outcome === 'failed'
                    ? 'transcript.commandFailed'
                    : item.outcome === 'stopped'
                      ? 'transcript.commandStopped'
                      : 'transcript.commandDone'
                )
              : item.kind === 'unknown-tool-call'
              ? // 名字可能是空的:ACP 允许 tool_call_update 不带 title,那一刻这条调用
                // 还没有名字。退回通用「工具」,❌ 不显示内部占位串(真机上曾以
                // 「unknown」四个字母出现在行标题里)。
                item.name || ctx.translate('transcript.tool')
              : item.kind === 'tool-group'
                ? item.label
                : ctx.translate('transcript.tool');
  const inputSummary =
    item.kind === 'search-tool-call'
      ? `${item.query}${item.matchCount !== undefined ? ` (${item.matchCount} matches)` : ''}`
      : item.kind === 'mcp-tool-call'
        ? toolCallLabel(item)
        : item.kind === 'web-fetch-tool-call'
          ? (item.pageTitle ?? item.url)
          : item.kind === 'spawn-subagent-tool-call'
            ? item.background
              ? ctx.translate('transcript.background', { name: item.name })
              : item.name
            : item.kind === 'subagent-done-tool-call'
              ? // 是**谁**跑完了。名字空着就不写这一格 —— 行上只剩「子智能体已完成」,
                // ❌ 不拿 agentId 顶上(claude 自己在工具结果里就写着那是内部 id、别给用户看)。
                item.name || undefined
            : item.kind === 'background-command-done-tool-call'
              ? // 是**哪条命令**跑完了(命令卡的标题)。
                item.name || undefined
              : // ❌ 不拿 `item.toolKind` 当摘要(#4981)。它是 ACP 协议的枚举
              // (read/edit/search/execute/fetch/switch_mode/**other**),不是给人读的词。
              // 实机上最常见的取值恰好是 `other` —— 于是行里出现「EnterPlanMode other」:
              // 一个协议内部说「我不认识这个」的标记,被当成参数摆给了用户看。
              base?.inputSummary;

  // 供应商没给摘要时,从它交给工具的参数现推一行(#4981)。
  //
  // ACP 的 kind 枚举只有 8 个值,`Skill` / `EnterPlanMode` / 所有 `mcp__*` 都不在其中,
  // 一律落进 `unknown-tool-call` ⇒ 行上只剩一个原始函数名,导航去了哪个网址、用了哪个
  // skill 全看不见。而参数一直都在(真机上量过:18 行工具展开后 14 行带着干净的
  // rawInput),只是藏在一次点击之后。
  //
  // ⚠️ 兜底,不是替代:供应商自己说的话优先,这里只在它没说时补位。
  const resolvedSummary = inputSummary ?? deriveToolInputSummary(base?.rawInput);
  // `outputText` before `rawOutput`: content blocks are the channel the provider
  // meant to be read, rawOutput is whatever the vendor happened to return.
  //
  // On a failed call this same text IS the failure reason — ACP carries it in
  // the content of the failing `tool_call_update` and has no separate error
  // field on a tool call, so there is nothing here to map onto `ChatToolCall.error`
  // and nothing sets it on the product path. tool.layout re-slots this text into
  // the failure section when the status says the call failed; that is the only
  // reason a red row has anything to show.
  const result = base ? (base.outputText ?? base.rawOutput) : undefined;
  return {
    kind: 'tool',
    id: item.id,
    name,
    status: 'status' in item ? item.status : 'done',
    awaitingPermission: base ? ctx.pendingToolCallIds().has(base.toolCallId) : false,
    inputSummary: resolvedSummary,
    ...(base?.rawInput !== undefined ? { request: base.rawInput } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(base?.images?.length ? { images: base.images.map(toolImageUrl) } : {}),
  };
}

export type ToolVars = {
  /** Fixed height (px) of the header row. */
  rowH: number;
  /** Max visual lines a disclosed payload section shows before it scrolls. */
  panelMaxLines: number;
};

const TOOL_VARS: ToolVars = {
  rowH: ROW_H,
  panelMaxLines: 12,
};

/**
 * Panel geometry for the current collapse state, or null when there is nothing
 * to show. Collapse is a Lane A input, so this is a pure function of the same
 * MeasureCtx the engine hands `measure` — which is what keeps the reserved
 * height and the painted height the same number through a toggle.
 *
 * The collapsed state is not an early return here even though every slot is now
 * gated on it: `layoutToolPayload` takes the expanded flag and decides per slot,
 * so which sections a state shows lives in one place instead of being split
 * between a guard here and a loop there. A collapsed row lays out to zero
 * sections and gets `null` from the length check below, which is the same answer
 * a guard would have given a line earlier.
 */
export function toolPayloadFor(
  item: ToolPayloadItem,
  ctx: MeasureCtx,
  vars: ToolVars = TOOL_VARS
): ToolPayloadGeometry | null {
  const sections = layoutToolPayload(item, ctx.width, ctx.theme.fonts, ctx.expanded(item.id));
  if (sections.length === 0) return null;
  return toolPayloadGeometry(sections, ctx.theme.fonts.code.lineHeight, vars);
}

/** The picture strip under the header (tool-images.ts): there whenever the call handed pictures back, open or closed. */
export function toolThumbsFor(item: Pick<ChatToolCall, 'images'>, ctx: MeasureCtx): ToolThumbStrip | null {
  return toolThumbStrip(item.images?.length ?? 0, ctx.width);
}

function toolUnitH(item: ChatToolCall, ctx: MeasureCtx, vars: ToolVars): number {
  return vars.rowH + (toolThumbsFor(item, ctx)?.stripH ?? 0) + (toolPayloadFor(item, ctx, vars)?.panelH ?? 0);
}

function ToolUnitRender(props: { data: ChatToolCall; ctx: RenderCtx; vars: ToolVars }) {
  const mCtx = () => props.ctx.measureCtx?.();
  // Inverted semantics: stored "collapsed" bool = "expanded".
  const isExpanded = () => props.ctx.viewState.isCollapsed(props.data.id);

  const payload = createMemo<ToolPayloadGeometry | null>(() => {
    const ctx = mCtx();
    if (!ctx) return null;
    return toolPayloadFor(props.data, ctx, props.vars);
  });

  // Derived from the same memo the panel renders from, not from a second call to
  // toolUnitH: two independent computations of one height is exactly the desync
  // `toolRoot { overflow: hidden }` exists to survive.
  const thumbs = createMemo<ToolThumbStrip | null>(() => {
    const ctx = mCtx();
    return ctx ? toolThumbsFor(props.data, ctx) : null;
  });
  const totalH = () => props.vars.rowH + (thumbs()?.stripH ?? 0) + (payload()?.panelH ?? 0);
  const codeLineH = () => mCtx()?.theme.fonts.code.lineHeight ?? 0;

  const styleVars = (): ToolStyleVars => ({ rowH: props.vars.rowH, height: totalH() });

  return (
    <div
      class={toolRoot}
      data-slot="tool-call"
      style={assignInlineVars(toolVars, pxTokens(styleVars()))}
    >
      <Tool
        item={props.data}
        collapsible={hasToolPayload(props.data)}
        expanded={isExpanded()}
        thumbs={thumbs()}
        payload={payload()}
        codeLineH={codeLineH()}
      />
    </div>
  );
}

export const toolUnitDef = defineUnit<ChatToolCall, ToolVars>({
  kind: 'tool',
  margin: { top: 2, bottom: 2 },
  vars: TOOL_VARS,

  estimate(item, ctx, vars): number {
    // O(1): no width-accurate wrap here, so count source lines rather than
    // visual ones. The virtualizer replaces this with measure() before the row
    // enters the window.
    //
    // Every section is gated on `expanded`, the failure reason included, so a
    // collapsed row estimates to its header exactly like a successful one. An
    // estimate that still counted the failure would guess every collapsed failed
    // row a section too tall, and the scrollbar would resettle as each came into
    // the window and got measured for real.
    const expanded = ctx.expanded(item.id);
    const counted: Array<[string | undefined, number]> = [
      [expanded ? toolFailureText(item) : undefined, vars.panelMaxLines],
      [expanded ? item.request : undefined, vars.panelMaxLines],
      [expanded ? toolDisclosedResult(item) : undefined, vars.panelMaxLines],
    ];
    const sourceLines = counted.reduce(
      (sum, [text, cap]) => (text ? sum + Math.min(text.split('\n').length, cap) : sum),
      0
    );
    return vars.rowH + (toolThumbsFor(item, ctx)?.stripH ?? 0) + sourceLines * ctx.theme.fonts.code.lineHeight;
  },

  measure(item, ctx, vars): number {
    return toolUnitH(item, ctx, vars);
  },

  Render: ToolUnitRender,
});
