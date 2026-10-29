/** @jsxImportSource solid-js */
import type { MeasureCtx, RenderCtx } from '@session-chat/core/define';
import type { SegmentCtx } from '@session-chat/core/units';
import { defineUnit } from '@session-chat/core/units';
import { pxTokens } from '@session-chat/styles/px-tokens';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import { Show, createMemo } from 'solid-js';
import { projectToolContent } from '@gugu/session-core/acp';
import { changedFilePaths } from '@gugu/session-core/acp';
import type { SessionPatch } from '@gugu/session-core/acp';
import type { ChatDiff, ToolNode } from '@session-chat/model';
import { Diff } from './Diff';
import { patchStats, selectPreview, type DiffRow } from './diff-lines';
import { langFromPath } from './lang';
import { diffCardVars, diffRoot, type DiffStyleVars } from './diff.css';
import { toolFailureReason } from '../tool-failure-reason';
import { diffBodyVisible } from './diff-visibility';
export { diffBodyVisible } from './diff-visibility';

export type DiffVars = { headerH: number; maxLines: number; context: number; border: number };
const DIFF_VARS: DiffVars = { headerH: 32, maxLines: 8, context: 1, border: 0 };

/** Only a projection: canonical blocks are never rewritten by a display caller. */
export function patchDiffFromItem(item: Extract<ToolNode, { kind: 'patch-tool-call' }>, ctx: SegmentCtx): ChatDiff {
  return {
    kind: 'diff', id: item.id, patches: projectToolContent(item.contentBlocks ?? []).diffs,
    status: item.status, awaitingPermission: ctx.pendingToolCallIds().has(item.toolCallId),
    ...(toolFailureReason(item) !== undefined ? { error: toolFailureReason(item) } : {}),
  };
}

export type PatchLayout = {
  patch: SessionPatch; previewRows: DiffRow[]; adds: number | null; dels: number | null;
  lang: string | undefined; truncated: boolean;
};
export type DiffLayout = { kind: 'diff'; sections: PatchLayout[] };

export function diffLayout(item: ChatDiff, ctx: MeasureCtx, vars: DiffVars): DiffLayout {
  return { kind: 'diff', sections: item.patches.map(patch => {
    const rows = ctx.caches.computeDiff(patch);
    const previewRows = selectPreview(rows, vars.maxLines, vars.context);
    const stats = patchStats(patch);
    const paths = changedFilePaths([patch]);
    return { patch, previewRows, adds: stats?.adds ?? null, dels: stats?.dels ?? null,
      lang: paths.length === 1 ? langFromPath(paths[0]) : undefined,
      truncated: previewRows.length > 0 && previewRows.at(-1) !== rows.at(-1) };
  }) };
}

function layoutH(item: ChatDiff, layout: DiffLayout, lineH: number, vars: DiffVars): number {
  if (!layout.sections.length) return vars.headerH;
  return layout.sections.reduce((sum, section) => sum + vars.headerH + (diffBodyVisible(item)
    ? (section.previewRows.length + (section.truncated ? 1 : 0)) * lineH + 2 * vars.border : 0), 0);
}

function DiffUnitRender(props: { data: ChatDiff; ctx: RenderCtx; vars: DiffVars }) {
  const mCtx = () => props.ctx.measureCtx?.();
  const layout = createMemo(() => { const ctx = mCtx(); return ctx ? diffLayout(props.data, ctx, props.vars) : null; });
  const lineH = () => mCtx()?.theme.fonts.code.lineHeight ?? 0;
  const styleVars = (): DiffStyleVars => ({ height: layout() ? layoutH(props.data, layout()!, lineH(), props.vars) : props.vars.headerH, headerH: props.vars.headerH });
  return <div class={diffRoot} style={assignInlineVars(diffCardVars, pxTokens(styleVars()))}>
    <Show when={layout()}>{value => <Diff item={props.data} layout={value()} codeLineHeight={lineH} headerH={props.vars.headerH} />}</Show>
  </div>;
}

export const diffUnitDef = defineUnit<ChatDiff, DiffVars>({
  kind: 'diff', margin: { top: 2, bottom: 6 }, vars: DIFF_VARS,
  estimate: (item, ctx, vars) => Math.max(1, item.patches.length) * (vars.headerH + (diffBodyVisible(item) ? vars.maxLines * ctx.theme.fonts.code.lineHeight : 0)),
  measure: (item, ctx, vars) => layoutH(item, diffLayout(item, ctx, vars), ctx.theme.fonts.code.lineHeight, vars),
  Render: DiffUnitRender,
});
