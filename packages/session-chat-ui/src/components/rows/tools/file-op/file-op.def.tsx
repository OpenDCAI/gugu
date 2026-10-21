/** @jsxImportSource solid-js */
import { ROW_H } from '@session-chat/components/engine/row-metrics';
import { PreviewWindow } from '@session-chat/components/primitives/PreviewWindow';
import type { MeasureCtx, RenderCtx } from '@session-chat/core/define';
import type { SegmentCtx } from '@session-chat/core/units';
import { defineUnit } from '@session-chat/core/units';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import { Show, createMemo } from 'solid-js';
import type { ChatFileOpToolCall, ToolNode } from '@session-chat/model';
import { FileOpRow, FileOpHeader, FileOpList, FileOpPreviewBody } from './FileOperation';
import { fileOpCardVars, fileOpRoot } from './file-op.css';
import { toolFailureReason } from '../tool-failure-reason';
import { ToolPayloadPanel } from '../tool/Tool';
import { toolPayloadFor } from '../tool/tool.def';
import { hasToolPayload } from '../tool/tool.layout';

export type FileOpVars = {
  /** Measure-only: fixed row height for header and per-file lines. */
  rowH: number;
  /** Style-relevant: vertical padding inside the file list. Consumed by fileOpCardVars. */
  padY: number;
  /** Measure-only: scrollable preview window height while running. */
  windowH: number;
};

export function readFileOpFromItem(
  item: Extract<ToolNode, { kind: 'read-tool-call' }>,
  ctx: SegmentCtx
): ChatFileOpToolCall {
  return {
    kind: 'file-op',
    id: item.id,
    op: 'read',
    status: item.status,
    ...(item.rawInput !== undefined ? { request: item.rawInput } : {}),
    ...((item.outputText ?? item.rawOutput) !== undefined
      ? { result: item.outputText ?? item.rawOutput } : {}),
    awaitingPermission: ctx.pendingToolCallIds().has(item.toolCallId),
    ops: item.path || item.resource ? [{ path: item.path ?? item.resource! }] : [],
    // 同 diff:这一格从没被赋过值,FileOperation.tsx 却把它当 title 显示(#4981)。
    ...(toolFailureReason(item) !== undefined ? { error: toolFailureReason(item) } : {}),
  };
}

export function deleteFileOpFromItem(
  item: Extract<ToolNode, { kind: 'delete-file-tool-call' }>,
  ctx: SegmentCtx
): ChatFileOpToolCall {
  return {
    kind: 'file-op',
    id: item.id,
    op: 'delete',
    status: item.status,
    ...(item.rawInput !== undefined ? { request: item.rawInput } : {}),
    ...((item.outputText ?? item.rawOutput) !== undefined
      ? { result: item.outputText ?? item.rawOutput } : {}),
    awaitingPermission: ctx.pendingToolCallIds().has(item.toolCallId),
    ops: [{ path: item.path }],
    ...(toolFailureReason(item) !== undefined ? { error: toolFailureReason(item) } : {}),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function measureFileOpH(item: ChatFileOpToolCall, ctx: MeasureCtx, vars: FileOpVars): number {
  const { rowH, padY, windowH } = vars;
  const isExpanded = ctx.expanded(item.id);
  const payloadH = toolPayloadFor(item, ctx)?.panelH ?? 0;

  if (item.ops.length <= 1) return rowH + payloadH;
  if (isExpanded) return rowH + item.ops.length * rowH + 2 * padY + payloadH;
  if (item.status === 'running') return rowH + windowH + payloadH;
  return rowH + payloadH;
}

// ── Render ────────────────────────────────────────────────────────────────────

function FileOpUnitRender(props: { data: ChatFileOpToolCall; ctx: RenderCtx; vars: FileOpVars }) {
  const rowH = () => props.vars.rowH;
  const padY = () => props.vars.padY;
  const windowH = () => props.vars.windowH;

  // Inverted semantics: stored "collapsed" bool = "expanded".
  const isExpanded = () => props.ctx.viewState.isCollapsed(props.data.id);
  const payload = createMemo(() => {
    const ctx = props.ctx.measureCtx?.();
    return ctx ? toolPayloadFor(props.data, ctx) : null;
  });

  const totalH = createMemo(() => {
    const ctx = props.ctx.measureCtx?.();
    if (!ctx) return props.vars.rowH;
    return measureFileOpH(props.data, ctx, props.vars);
  });

  /**
   * Whether the per-file list holds anything back while collapsed.
   *
   * A finished multi-file row collapses to the header alone, so the whole list is
   * behind the chevron. A running one collapses to a fixed preview window, so it
   * hides something only once the list outgrows that window. The comparison is
   * written out rather than shortened to `true` because both halves are geometry:
   * lower `rowH` or raise `windowH` and the running branch really can stop hiding.
   */
  const collapsible = createMemo(() => {
    const item = props.data;
    if (hasToolPayload(item)) return true;
    if (item.ops.length <= 1) return false;
    const listH = item.ops.length * rowH() + 2 * padY();
    return item.status === 'running' ? listH > windowH() : listH > 0;
  });

  return (
    <div class={fileOpRoot} style={assignInlineVars({ [fileOpCardVars.height]: `${totalH()}px` })}>
      <Show
        when={props.data.ops.length > 1}
        fallback={<FileOpRow item={props.data} rowH={rowH()} collapsible={collapsible()} expanded={isExpanded()} />}
      >
        <FileOpHeader
          item={props.data}
          expanded={isExpanded()}
          collapsible={collapsible()}
          rowH={rowH()}
        />
        <Show when={isExpanded()}>
          <FileOpList item={props.data} lineH={rowH()} padY={padY()} />
        </Show>
        <Show when={!isExpanded() && props.data.status === 'running'}>
          <PreviewWindow
            height={windowH()}
            maxH={windowH()}
            overlay="fade-top"
            autoScrollBottom
            contentHeight={() => props.data.ops.length}
          >
            <FileOpPreviewBody item={props.data} lineH={rowH()} padY={padY()} />
          </PreviewWindow>
        </Show>
      </Show>
      <Show when={payload()}>
        {(value) => <ToolPayloadPanel payload={value()} codeLineH={props.ctx.measureCtx?.().theme.fonts.code.lineHeight ?? 0} />}
      </Show>
    </div>
  );
}

// ── UnitDef ───────────────────────────────────────────────────────────────────

export const fileOpUnitDef = defineUnit<ChatFileOpToolCall, FileOpVars>({
  kind: 'file-op',
  margin: { top: 2, bottom: 2 },
  vars: {
    rowH: ROW_H,
    padY: 6,
    windowH: 72,
  },

  estimate(item, ctx, vars): number {
    return measureFileOpH(item, ctx, vars);
  },

  measure(item, ctx, vars): number {
    return measureFileOpH(item, ctx, vars);
  },

  Render: FileOpUnitRender,
});
