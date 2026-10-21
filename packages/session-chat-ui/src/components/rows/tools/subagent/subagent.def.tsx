/** @jsxImportSource solid-js */
import { useTheme } from '@session-chat/components/contexts/ThemeContext';
import { HEADER_ROW_EXTRA_H } from '@session-chat/components/engine/row-metrics';
import type { MeasureCtx, RenderCtx } from '@session-chat/core/define';
import type { SegmentCtx } from '@session-chat/core/units';
import { defineUnit } from '@session-chat/core/units';
import { pxTokens } from '@session-chat/styles/px-tokens';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import { createMemo, Show } from 'solid-js';
import type { ChatSubagentToolCall, SubagentPhase, ToolNode } from '@session-chat/model';
import { ToolPayloadPanel } from '../tool/Tool';
import { toolPayloadFor } from '../tool/tool.def';
import { hasToolPayload } from '../tool/tool.layout';
import { SubagentHeader } from './Subagent';
import { toolFailureReason } from '../tool-failure-reason';
import { subagentRoot, subagentVars } from './subagent.css';

type SpawnSubagentToolNode = Extract<ToolNode, { kind: 'spawn-subagent-tool-call' }>;

export function subagentPhase(
  item: Pick<ChatSubagentToolCall, 'status' | 'agentId'>
): SubagentPhase {
  if (item.status === 'done') return 'completed';
  if (item.status === 'error') return 'failed';
  return item.agentId ? 'running' : 'spawning';
}

export function subagentFromItem(
  item: SpawnSubagentToolNode,
  ctx: SegmentCtx
): ChatSubagentToolCall {
  const agentId = item.agentId || undefined;
  const status = item.status;
  // 取因逻辑抽去了 `../tool-failure-reason` —— 同一个 bug 在这个目录里有三份
  // (subagent / diff / file-op 各读一个不存在的 `item.error`),合成一处免得再分叉。
  const error = toolFailureReason(item);
  // 行上说两件事:**这是一个子智能体**(固定的行为词),以及**它被派去做什么**(片)。
  // 与 执行 / 读取 / 搜索 / 获取 / MCP 工具 各行同一个骨架,也就是 assistant-ui
  // tool-timeline 的 icon + verb + chip。
  //
  // ⚠️ ❌ 不再把供应商的 title 当名字直接印。两头都不对:
  //   · claude 那边 ACP 的 title **就是描述本身**(适配器 tools.js:23 写死
  //     `input.description`)⇒ 印出来会和片一字不差地重复;
  //   · title 缺席时它又退化成一个原始工具名(`Agent`)—— 那是 claude 那侧的函数名,
  //     不是给读者看的词。
  // owner 2026-09-05:「tool call 形态的消息说启动智能体了,这样才统一」——
  // 转录里这一行与「执行」「读取」「搜索」同一个形态:一个动词 + 它干了什么。
  // 汇总视图(上游 elements-subagent-list)在「输出/来源」面板里,不在这儿。
  const name = ctx.translate('transcript.subagentSpawn');
  // 派活时给的那句描述。少了它,并行的几个子任务在行上无法区分(#4981)。
  // `title` 兜底是为了不丢信息:有的供应商只填 ACP title 不填 rawInput。
  const task = item.inputSummary || item.title || undefined;
  return {
    kind: 'subagent',
    id: item.id,
    name,
    status,
    phase: subagentPhase({ status, agentId }),
    agentId,
    ...(item.reasoningText ? { reasoning: item.reasoningText } : {}),
    ...(item.rawInput !== undefined ? { request: item.rawInput } : {}),
    ...((item.outputText ?? item.rawOutput) !== undefined
      ? { result: item.outputText ?? item.rawOutput } : {}),
    ...(task !== undefined ? { task } : {}),
    background: item.background,
    awaitingPermission: ctx.pendingToolCallIds().has(item.toolCallId),
    error,
  };
}

export type SubagentVars = {
  /** Extra vertical space (px) added to the body line-height for the header row. */
  headerExtraH: number;
};

const SUBAGENT_VARS: SubagentVars = {
  headerExtraH: HEADER_ROW_EXTRA_H,
};

export function hasSubagentPayload(item: ChatSubagentToolCall): boolean {
  return hasToolPayload(item);
}

export function subagentPayloadFor(item: ChatSubagentToolCall, ctx: MeasureCtx) {
  return toolPayloadFor(item, ctx);
}

function SubagentUnitRender(props: {
  data: ChatSubagentToolCall;
  ctx: RenderCtx;
  vars: SubagentVars;
}) {
  const theme = useTheme();
  const height = () => theme().fonts.body.lineHeight + props.vars.headerExtraH;
  const payload = createMemo(() => {
    const ctx = props.ctx.measureCtx?.();
    return ctx ? subagentPayloadFor(props.data, ctx) : null;
  });

  return (
    <div
      class={subagentRoot}
      style={assignInlineVars(subagentVars, pxTokens({ height: height() + (payload()?.panelH ?? 0) }))}
    >
      <SubagentHeader
        item={props.data}
        height={height()}
        collapsible={hasSubagentPayload(props.data)}
        expanded={props.ctx.viewState.isCollapsed(props.data.id)}
      />
      <Show when={payload()}>
        {(value) => <ToolPayloadPanel payload={value()} codeLineH={theme().fonts.code.lineHeight} />}
      </Show>
    </div>
  );
}

export const subagentUnitDef = defineUnit<ChatSubagentToolCall, SubagentVars>({
  kind: 'subagent',
  margin: { top: 2, bottom: 8 },
  vars: SUBAGENT_VARS,

  estimate(item, ctx, vars): number {
    return ctx.theme.fonts.body.lineHeight + vars.headerExtraH + (subagentPayloadFor(item, ctx)?.panelH ?? 0);
  },

  measure(item, ctx, vars): number {
    return ctx.theme.fonts.body.lineHeight + vars.headerExtraH + (subagentPayloadFor(item, ctx)?.panelH ?? 0);
  },

  Render: SubagentUnitRender,
});
