/**
 * Core definition primitives.
 *
 * Key types:
 *   Measured<L>  — universal measurement result: height + width + typed layout.
 *   MeasureCtx   — read-only inputs for every estimate / measure call.
 *   RenderCtx    — callbacks available to every Render component.
 *
 * ── State split (Lane A vs Lane B) ──────────────────────────────────────────
 *
 * Lane A — layout-affecting state. These are the ONLY inputs that must be
 * reflected in `MeasureCtx` and can legitimately cause `virt.setSize` to be called:
 *   • `ctx.width`          — available column width (px)
 *   • `ctx.expanded(id)`   — resolved collapse state for collapsible defs
 *   • `ctx.measureEpoch`   — bumped after font load to invalidate blockMemo
 *   • `ctx.expandedId`     — id of the single expanded user message card
 *
 * Lane B — presentational / ephemeral state. These must NEVER enter `measure`
 * or any height fingerprint because they do not affect height:
 *   • copied state (code block copy button)
 *   • hover / focus state
 *   • shimmer / loading animation flags
 *   • selection state
 *   • timer ticks
 */

import type { BackgroundCommandEntry } from '@session-chat/lib/background-command-roster';
import type { SubagentRosterEntry } from '@session-chat/lib/subagent-roster';
import type { ChatCaches } from './caches';
import type { ChatTheme } from './theme';
import type { ChatTranslator } from '@session-chat/localization';
import type { ChatCommands } from '@session-chat/commands';
import type { SelfIdentity } from '@session-chat/lib/self-identity';

// ── Measured ──────────────────────────────────────────────────────────────────

/**
 * Universal measurement output.
 *
 * `layout` is a discriminated payload typed per component.
 * `width` is the natural content width; for most rows it equals the available
 * container width.
 */
export type Measured<L = unknown> = {
  height: number;
  width: number;
  layout: L;
};

// ── Contexts ──────────────────────────────────────────────────────────────────

/**
 * Read-only inputs available to every `measure` call (and optional `estimate`).
 *
 * `theme`        — full ChatTheme (fonts, chips). Constant for the lifetime of a ChatRoot.
 * `width`        — available horizontal space in px.
 * `isCollapsed`  — raw view-state collapse flag (for block-level collapse).
 * `expanded`     — engine-resolved "is expanded" for the row. For native UnitDef
 *                  composites, `expanded(id)` = `isCollapsed(id)` (inverted
 *                  semantics: stored "collapsed" flag means "expanded").
 * `measureEpoch` — optional monotonic counter bumped after fonts load to force
 *                  `blockMemo` cache misses even when width is unchanged.
 *                  This clears fallback-font geometry and prevents
 *                  `contain: paint` from clipping under-measured content.
 * `expandedId`  — optional id of the single currently-expanded user message card.
 *                 When `expandedId === item.id` the card is measured at the
 *                 expanded max-height; all other user messages use the collapsed
 *                 max-height. Only affects user-role message units.
 */
export type MeasureCtx = {
  theme: ChatTheme;
  /** The same text services as Render: localized labels are layout inputs when they wrap. */
  translate?: ChatTranslator;
  commands?: ChatCommands;
  selfIdentity?: SelfIdentity | null;
  chatName?: (id: string) => string | null;
  appName?: (id: string) => string | null;
  width: number;
  isCollapsed: (id: string) => boolean;
  expanded: (id: string) => boolean;
  caches: ChatCaches;
  measureEpoch?: number;
  expandedId?: string | null;
  /** Latest visible conversation bubble: full text without persisting a manual expansion. */
  latestConversationMessageId?: string | null;
  /** The inline user-message editor replaces the measured bubble. */
  editingMessage?: { itemId: string; text: string };
  /**
   * 「跑完后的最后一条回复」的 id（#4981）—— 只有它带页脚（复制按钮那一行的高度）。
   * 会话还在忙（在流式、等后台子智能体、agent 自发的 cycle 没收口）时为 null：
   * 那时任何一段都只是临时片段，❌ 不给页脚、不留空。owner 2026-09-06：「每个段落中间
   * 大片空白，都是隐藏的复制按钮……只有运行完的最后一段有复制按钮行不」。
   * 由 ChatRoot 算（`finalReplyId`），行里只比对，❌ 不自己猜。
   */
  finalReplyId?: string | null;
  /**
   * 还在跑的后台任务挂在哪条回复的过程行上(owner 2026-10-27 原型:与「执行中」同一行)。只有 `ownerId`
   * 那一条量出它(单子展开时多出单子的高)。null / 缺省 = 没有挂在哪条回复上(没有后台任务,或它单独成行)。
   * 由 ChatRoot 算(`backgroundAttachment`),行里只比对。
   */
  background?: {
    ownerId: string;
    commands: readonly BackgroundCommandEntry[];
    subagents: readonly SubagentRosterEntry[];
    expanded: boolean;
  } | null;
};

/**
 * Callbacks available to every Render component.
 *
 * `viewState`   — collapse / toggle callbacks.
 * `measureCtx`  — optional reactive accessor supplying the lane-A MeasureCtx
 *                 for this unit (set by UnitRow for native UnitDef renders).
 *                 Native UnitDef.Render components call `props.ctx.measureCtx?.()`
 *                 to access theme, width, and caches for re-measuring inside
 *                 the render (e.g. leaf blocks after `measureBlockCached`).
 * `clipHeight`  — animated content height (px) while a collapse/expand tween
 *                 runs; null at rest. Card-style renders (plan, execute) use
 *                 `clipHeight?.() ?? ownHeight` so their bordered root element
 *                 tracks the animated bottom edge instead of being clipped by
 *                 the engine wrapper — keeping the bottom border visible
 *                 throughout the tween. Non-card renders ignore it.
 */
export type RenderCtx = {
  viewState: { isCollapsed: (id: string) => boolean };
  measureCtx?: () => MeasureCtx;
  clipHeight?: () => number | null;
};
