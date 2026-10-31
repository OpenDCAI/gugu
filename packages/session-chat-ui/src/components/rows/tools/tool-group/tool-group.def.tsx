/** @jsxImportSource solid-js */
/**
 * ToolGroup — collapsible composite unit for hierarchical tool calls.
 *
 * A tool-group node is rendered as a single collapsible composite row instead
 * of a flat row for each child tool call.
 *
 * Layout:
 *   ┌─ CollapseHeader/SubagentHeader ─────────────────────────────┐
 *   │ PreviewWindow (collapsed) OR ChildStack (expanded)          │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Children are dispatched to their native leaf UnitDef.Render with no inset.
 * Multi-level nesting is handled by recursing through `ToolGroupRender`.
 */

import { useTheme } from '@session-chat/components/contexts/ThemeContext';
import { HEADER_ROW_EXTRA_H, ROW_H } from '@session-chat/components/engine/row-metrics';
import { CollapseHeader } from '@session-chat/components/primitives/CollapseHeader';
import { PreviewWindow } from '@session-chat/components/primitives/PreviewWindow';
import { diffUnitDef } from '@session-chat/components/rows/tools/diff/diff.def';
import { executeUnitDef } from '@session-chat/components/rows/tools/execute/execute.def';
import { fileOpUnitDef } from '@session-chat/components/rows/tools/file-op/file-op.def';
import { SubagentHeader } from '@session-chat/components/rows/tools/subagent/Subagent';
import { hasSubagentPayload, subagentPayloadFor, subagentUnitDef } from '@session-chat/components/rows/tools/subagent/subagent.def';
import { ToolPayloadPanel } from '@session-chat/components/rows/tools/tool/Tool';
import { toolUnitDef } from '@session-chat/components/rows/tools/tool/tool.def';
import type { MeasureCtx, RenderCtx } from '@session-chat/core/define';
import { withWidth, withWidthCtx } from '@session-chat/core/layout/box';
import type { UnitDef } from '@session-chat/core/units';
import { defineUnit } from '@session-chat/core/units';
import type { ItemNode } from '@session-chat/state/flatten';
import { pxTokens } from '@session-chat/styles/px-tokens';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import type { JSX } from 'solid-js';
import { For, Show, createMemo } from 'solid-js';
import type { ChatItem, ChatSubagentToolCall, ChatToolCall } from '@session-chat/model';
import { toolGroupCardVars, toolGroupChildStack, toolGroupRoot } from './tool-group.css';
import {
  SUBAGENT_HEADER_GAP,
  SUBAGENT_INDICATOR_W,
  subagentChildrenOffset,
} from '@session-chat/components/rows/tools/subagent/subagent.css';

// ── Vars ──────────────────────────────────────────────────────────────────────

export type ToolGroupVars = {
  /** Max height (px) of the collapsed preview window. */
  windowH: number;
  /** Vertical gap (px) between consecutive children. */
  childGap: number;
};

const TOOL_GROUP_VARS: ToolGroupVars = {
  windowH: 180,
  childGap: 4,
};

// ── Child dispatch table ──────────────────────────────────────────────────────
//
// Direct imports of leaf defs avoids a circular dependency on unit-registry.ts.
// Only tool-family kinds can appear as children.

// registry boundary
const CHILD_DEFS: Record<string, UnitDef<any, any>> = {
  tool: toolUnitDef,
  subagent: subagentUnitDef,
  execute: executeUnitDef,
  diff: diffUnitDef,
  'file-op': fileOpUnitDef,
};

// ── Geometry helpers ──────────────────────────────────────────────────────────

// Subagent and non-subagent parents share one header height: the subagent
// header stopped being two stacked rows in the #3334 P3 redraw, so the branch
// that used to pick between two formulas has nothing left to pick between.
function headerH(ctx: MeasureCtx): number {
  return ctx.theme.fonts.body.lineHeight + HEADER_ROW_EXTRA_H;
}

function isSubagentItem(item: ChatItem): item is ChatSubagentToolCall {
  return item.kind === 'subagent';
}

/**
 * How far a subagent's children are indented from the group's own left edge.
 *
 * Read off the same two constants `subagentChildrenOffset` composes its
 * `margin-left` from, so the width handed to the child measure context cannot
 * drift from the margin the child is actually rendered behind. Children of a
 * subagent get that much less room, and rows whose height depends on their width
 * — execute wraps its command against it — measure short if they are not told.
 */
const subagentChildrenOffsetX = SUBAGENT_INDICATOR_W + SUBAGENT_HEADER_GAP;

function isActiveItem(item: ChatItem): boolean {
  if (isSubagentItem(item)) return item.phase === 'spawning' || item.phase === 'running';
  return (item as ChatToolCall).status === 'running';
}

function canShowCollapsedPreview(item: ChatItem): boolean {
  return !isSubagentItem(item) && isActiveItem(item);
}

/**
 * Recursively sum the measured heights of all children in `node`.
 * Gaps between consecutive children are included.
 */
function childrenHeight(node: ItemNode, ctx: MeasureCtx, vars: ToolGroupVars): number {
  if (node.children.length === 0) return 0;
  const childCtx = isSubagentItem(node.item)
    ? withWidth(ctx, ctx.width - subagentChildrenOffsetX)
    : ctx;
  let h = 0;
  for (let i = 0; i < node.children.length; i++) {
    if (i > 0) h += vars.childGap;
    const child = node.children[i];
    if (child.children.length > 0) {
      // Recurse: child is itself a parent.
      h += toolGroupUnitDef.measure(child, childCtx, vars);
    } else {
      const def = CHILD_DEFS[child.item.kind];
      h += def ? def.measure(child.item, childCtx, def.vars ?? {}) : ROW_H;
    }
  }
  return h;
}

function toolGroupUnitH(node: ItemNode, ctx: MeasureCtx, vars: ToolGroupVars): number {
  const chH = childrenHeight(node, ctx, vars);
  const isExpanded = ctx.expanded(node.item.id);
  const showPreview = canShowCollapsedPreview(node.item);
  const payloadH = isSubagentItem(node.item) ? (subagentPayloadFor(node.item, ctx)?.panelH ?? 0) : 0;
  return headerH(ctx) + payloadH + (isExpanded ? chH : showPreview ? Math.min(chH, vars.windowH) : 0);
}

// ── ChildStack ────────────────────────────────────────────────────────────────

/**
 * Render a leaf child (no children of its own) by dispatching to the native
 * def's Render component. The def is looked up once from CHILD_DEFS; `kind`
 * never changes on an existing item.
 */
function ChildLeaf(props: { node: ItemNode; ctx: RenderCtx; vars: ToolGroupVars }) {
  const def = CHILD_DEFS[props.node.item.kind];
  if (!def) return null;
  // Assign to a PascalCase local so JSX treats it as a component call.
  // registry boundary
  const Renderer = def.Render as (p: { data: ChatItem; ctx: RenderCtx; vars: any }) => JSX.Element;
  return <Renderer data={props.node.item} ctx={props.ctx} vars={def.vars ?? {}} />;
}

/**
 * Render one child node, dispatching to the recursive ToolGroupRender for
 * nested parents or to the native leaf def for leaf children.
 */
function ChildItem(props: { node: ItemNode; ctx: RenderCtx; vars: ToolGroupVars }) {
  return (
    <Show
      when={props.node.children.length > 0}
      fallback={<ChildLeaf node={props.node} ctx={props.ctx} vars={props.vars} />}
    >
      {/* Recursive parent */}
      <ToolGroupRender data={props.node} ctx={props.ctx} vars={props.vars} />
    </Show>
  );
}

// @@@no wrapper per child — the stack used to emit one positioning div per
// child carrying an inline `margin-top` that was suppressed on the first one.
// A single gapped column states the same rule once: N children cost N wrapper
// elements before, 0 now, and "the first child has no gap" stops being a
// per-child conditional that can drift out of step with `childrenHeight`.
function ChildStack(props: { node: ItemNode; ctx: RenderCtx; vars: ToolGroupVars }) {
  return (
    <div class={toolGroupChildStack} style={{ gap: `${props.vars.childGap}px` }}>
      <For each={props.node.children}>
        {(child) => <ChildItem node={child} ctx={props.ctx} vars={props.vars} />}
      </For>
    </div>
  );
}

// ── Render ────────────────────────────────────────────────────────────────────

function ToolGroupRender(props: { data: ItemNode; ctx: RenderCtx; vars: ToolGroupVars }) {
  const theme = useTheme();
  const mCtx = () => props.ctx.measureCtx?.();

  // Inverted semantics: stored "collapsed" = "expanded".
  const isExpanded = () => props.ctx.viewState.isCollapsed(props.data.item.id);

  const isSubagent = () => isSubagentItem(props.data.item);
  const hH = () => theme().fonts.body.lineHeight + HEADER_ROW_EXTRA_H;
  const payload = createMemo(() => {
    const ctx = mCtx();
    const item = props.data.item;
    return ctx && isSubagentItem(item) ? subagentPayloadFor(item, ctx) : null;
  });

  const chH = createMemo(() => {
    const ctx = mCtx();
    if (!ctx) return 0;
    return childrenHeight(props.data, ctx, props.vars);
  });

  const totalH = createMemo(() => {
    const ctx = mCtx();
    if (!ctx) return hH();
    return toolGroupUnitH(props.data, ctx, props.vars);
  });

  const isActive = () => isActiveItem(props.data.item);
  const label = () => {
    const item = props.data.item;
    if (item.kind === 'tool') return (item as ChatToolCall).name;
    return item.kind;
  };

  const showCollapsedPreview = () => canShowCollapsedPreview(props.data.item);
  const previewH = () => Math.min(chH(), props.vars.windowH);
  /**
   * Whether expanding shows children the collapsed row does not already show.
   *
   * The collapsed body is the preview window while the group is running and
   * nothing at all once it has settled — so a settled group hides its whole
   * child stack, while a running one whose children already fit the window hides
   * nothing and expanding it repaints the same rows at the same height.
   */
  const collapsedBodyH = () => (showCollapsedPreview() ? Math.min(chH(), props.vars.windowH) : 0);
  const collapsible = createMemo(() => chH() > collapsedBodyH()
    || (isSubagentItem(props.data.item) && hasSubagentPayload(props.data.item)));
  const childCtx = createMemo(() => {
    const ctx = mCtx();
    if (!isSubagent() || !ctx) return props.ctx;
    return withWidthCtx(props.ctx, ctx.width - subagentChildrenOffsetX);
  });
  const childStack = () => (
    <Show
      when={isSubagent()}
      fallback={<ChildStack node={props.data} ctx={childCtx()} vars={props.vars} />}
    >
      <div class={subagentChildrenOffset}>
        <ChildStack node={props.data} ctx={childCtx()} vars={props.vars} />
      </div>
    </Show>
  );

  return (
    <div
      class={toolGroupRoot}
      style={assignInlineVars(toolGroupCardVars, pxTokens({ height: totalH() }))}
    >
      <Show
        when={isSubagent()}
        fallback={
          <CollapseHeader
            id={props.data.item.id}
            collapsible={collapsible()}
            expanded={isExpanded()}
            active={isActive()}
            height={hH()}
          >
            {label()}
          </CollapseHeader>
        }
      >
        <SubagentHeader
          item={props.data.item as ChatSubagentToolCall}
          expanded={isExpanded()}
          height={hH()}
          collapsible={collapsible()}
        />
      </Show>
      <Show when={payload()}>
        {(value) => <ToolPayloadPanel payload={value()} codeLineH={theme().fonts.code.lineHeight} />}
      </Show>
      <Show
        when={isExpanded()}
        fallback={
          <Show when={showCollapsedPreview() && chH() > 0}>
            <PreviewWindow
              height={previewH()}
              maxH={props.vars.windowH}
              overlay={
                // The fade promises more below, same as the chevron does. Only
                // draw it when the window is actually cutting something off.
                collapsible() ? 'fade-bottom' : undefined
              }
              autoScrollBottom={isActive()}
              contentHeight={chH}
            >
              {childStack()}
            </PreviewWindow>
          </Show>
        }
      >
        {childStack()}
      </Show>
    </div>
  );
}

// ── UnitDef ───────────────────────────────────────────────────────────────────

export const toolGroupUnitDef = defineUnit<ItemNode, ToolGroupVars>({
  kind: 'tool-group',
  margin: { top: 2, bottom: 2 },
  vars: TOOL_GROUP_VARS,

  estimate(node, ctx, vars): number {
    const isExpanded = ctx.expanded(node.item.id);
    const showPreview = canShowCollapsedPreview(node.item);
    // Approximate: 32px per child.
    const chH = node.children.length * ROW_H;
    const payloadH = isSubagentItem(node.item) ? (subagentPayloadFor(node.item, ctx)?.panelH ?? 0) : 0;
    return headerH(ctx) + payloadH + (isExpanded ? chH : showPreview ? Math.min(chH, vars.windowH) : 0);
  },

  measure(node, ctx, vars): number {
    return toolGroupUnitH(node, ctx, vars);
  },

  Render: ToolGroupRender,
});
