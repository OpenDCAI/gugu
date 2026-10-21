/** @jsxImportSource solid-js */
/**
 * ChatRoot — the Solid component that implements the chat transcript renderer.
 *
 * Architecture (ChatContext / ChatState / ChatView split):
 *   - ChatContext is passed as `props.context`: provides theme, shared caches,
 *     measureEpoch, and the Shiki highlighter.
 *   - ChatState is passed as `props.state`: provides transcript + parse caches.
 *   - ChatState is passed as `props.state`: provides transcript, parse caches,
 *     and per-conversation view state (viewState, expandedUserId, scroll anchor,
 *     heightmap). These survive view dispose/recreate (e.g. tab switches).
 *   - ChatRoot owns the virtualizer, frame scheduler, and tween registry.
 *
 * Scheduler hardening (aligned with CodeMirror's measure cycle):
 *   - Created eagerly (before `onMount`) so tween arming never hits a null ref.
 *   - try/catch around phases; re-arm always executes in `finally`.
 *   - Visibility watchdog: `forceReconcile()` on visibilitychange and on attach.
 *
 * Width invalidation (A6 — per-row dirty via fingerprint):
 *   - clearTextMeasure() is NOT called on width change. The per-block fingerprint
 *     (measureEpoch|width|collapsed) already handles width invalidation.
 *   - prepareRichInline is width-independent (intrinsic glyph widths), so it
 *     is retained in SharedCaches without flushing on resize.
 *
 * Composer slot (A7):
 *   - When `composer === 'slot'`, ChatRoot renders a sticky bottom slot inside
 *     outerClip. An internal ResizeObserver drives `padBottom` automatically.
 *   - `controls.composerSlot` exposes the slot HTMLElement so the host can
 *     portal a React composer into it.
 */

import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  untrack,
  useContext,
} from 'solid-js';
import type { ChatContext } from './chat-context';
import { ChatTranslationProvider } from './localization';
import { SelfIdentityProvider } from './lib/self-identity';
import { SenderAvatarProvider } from './lib/sender-avatar';
import { AppNameProvider } from './lib/app-name';
import { CHAT_COMPOSER_EDGE_FADE_PX } from './layout-geometry';
import { collectSubagentRoster } from './lib/subagent-roster';
import type { ChatCommands, ScrollToItemOptions } from './commands';
import { CachesContext } from './components/contexts/CachesContext';
import { CommandsContext } from './components/contexts/CommandsContext';
import { DebugContext } from './components/contexts/debug-context';
import { ThemeContext } from './components/contexts/ThemeContext';
import { TurnStateContext } from './components/contexts/TurnStateContext';
import { createFrameScheduler } from './components/engine/frame-scheduler';
import { createTweenRegistry } from './components/engine/tween-registry';
import { SEGMENTERS, UNIT_REGISTRY } from './components/engine/unit-registry';
import { UnitRow } from './components/engine/UnitRow';
import type { ChatCaches } from './core/caches';
import type { ThemeVarKey } from './core/config';
import type { MeasureCtx } from './core/define';
import { genericEstimate } from './core/layout/generic-estimate';
import { STICK_THRESHOLD_PX } from './core/stick-to-bottom';
import { unitReservedHeight } from './core/units';
import { Virtualizer } from './core/virtualizer';
import type { ChatItem, ChatMessage, TranscriptTurn } from './model';
import type { ChatState, ScrollMode } from './state/chat-state';
import { pendingPromptTurn } from './state/pending-prompt';
import {
  flattenTier,
  isDeliveredFromAgent,
  makeUnitsView,
  collectUserTurnUnits,
  trailingDayKey,
} from './state/flatten';
import type { UnitsView } from './state/flatten';
import { segmentCtxFor } from './state/segment-ctx';
import type { LayoutSnapshot } from './state/geometry';
import { sameRange } from './state/geometry';
import {
  canvas,
  composerSlotAnimatingClass,
  composerSlotCenteredClass,
  composerSlotClass,
  composerSlotInnerBottomClass,
  composerSlotInnerCenteredClass,
  composerSlotInnerClass,
  contentOverlaySlotClass,
  defaultContentClass,
  heroSlotClass,
  heroSlotHiddenClass,
  heroSlotVisibleClass,
  outerClip,
  pinFade,
  pinLane,
  pinSticky,
  scrollContainer,
  scrollContainerEmbedded,
  unitRowWrapper,
  widthProbeClass,
} from './chat-root.css';
import './chat-fonts.css';
import { vars } from './styles/theme.css';

// Centered content column. The scroll container stays full width (so the
// scrollbar sits at the viewport edge) while rows are measured and laid out
// against this capped, centered canvas — matching the desktop composer width.
const DEFAULT_CONTENT_CLASS = defaultContentClass;

// Vertical breathing room added above the first row and below the last row.
const TRANSCRIPT_VERTICAL_PADDING = 32;

// Symmetric overscan used when idle or velocity unknown
const OVERSCAN_BASE = 12;
// Leading buffer in the direction of scroll; trailing buffer behind it
const OVERSCAN_LEADING = 20;
const OVERSCAN_TRAILING = 8;

// Idle-time prefetch: how many rows beyond the overscan window to pre-measure
// during requestIdleCallback slices. Rows ahead in scroll direction get a
// larger budget; behind get a smaller one.
const PREFETCH_AHEAD = 40;
const PREFETCH_BEHIND = 20;
// Stop the current idle slice if less than this many ms remain (leaves headroom
// for the browser's own idle tasks).
const PREFETCH_MIN_REMAINING_MS = 3;

// onReachStart fires when the top row is visible and scrollTop is within this
// threshold of the canvas top. Debounced: only fires once until reset.
const REACH_START_THRESHOLD_PX = 200;

// Maximum absolute scrollTop delta that can originate from a writeScrollTop
// self-write (sub-pixel / device-pixel rounding). Any delta larger than this
// is classified as a real user scroll and updates lastUserScrollAt.
// Keeping it tight (0.5 px) avoids suppressing short-distance programmatic
// adjustments that should also be treated as self-writes.
const USER_SCROLL_EPSILON = 0.5;

// After a user/smooth scroll, suppress anchor projection until the gesture has
// been quiet this long. Must be comfortably longer than one rAF frame (~16 ms)
// so a momentary hold or an inter-event gap mid-drag does not open the gate
// and let projectAnchor jump the thumb forward. Tunable.
const SCROLL_SETTLE_MS = 120;

export type ComposerPlacement = 'bottom' | 'center';

export type ComposerPlacementOptions = {
  animate?: boolean;
};

function resolveComposerPlacement(
  value: ComposerPlacement | (() => ComposerPlacement) | undefined
): ComposerPlacement {
  return value === undefined ? 'bottom' : typeof value === 'function' ? value() : value;
}

function findLastUserMessageId(turns: readonly TranscriptTurn[]): string | null {
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
    const turn = turns[turnIndex];
    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex--) {
      const item = turn.items[itemIndex];
      // 别的 agent 投递进来的通知不算「人刚发言」—— 它不该把视图拽到底、也不该被钉住
      // (owner 2026-09-06:「更不应该有 stick 效果」)。
      if (item.kind === 'message' && item.role === 'user' && !isDeliveredFromAgent(item)) {
        return item.id;
      }
    }
  }
  return null;
}

// ── EngineControls ────────────────────────────────────────────────────────────

/**
 * Mutable holder populated by ChatRoot.onMount. createChatView creates an
 * instance and passes it to ChatRoot; the ChatView handle methods delegate to
 * it so callers never hold stale closures.
 */
export type EngineControls = {
  scrollToTop(opts?: { behavior?: ScrollBehavior }): void;
  scrollToBottom(opts?: { behavior?: ScrollBehavior }): void;
  scrollToItem(id: string, opts?: ScrollToItemOptions): void;
  loadOlder(turns: TranscriptTurn[]): void;
  /** Toggle collapse for an item by id (for view.toggleCollapsed). */
  toggleCollapsed?(id: string): void;
  /**
   * Reference to the composer slot element. Set by ChatRoot after mount when
   * `composer === 'slot'`. The host portals its React composer into this element.
   */
  composerSlot?: HTMLElement | null;
  /**
   * Reference to the hero slot element rendered above the composer in centered
   * placement. Hosts can portal empty-state copy into this element.
   */
  heroSlot?: HTMLElement | null;
  /**
   * Reference to the content overlay slot element. Set after mount when
   * `contentOverlay` is true. The host portals overlay content into it.
   */
  contentOverlay?: HTMLElement | null;
  /**
   * Declaratively set scroll intent; ChatRoot projects it immediately.
   * Wired by onMount; safe to call from outside the Solid reactive context.
   */
  setScrollMode?(mode: ScrollMode): void;
  /** Move the library-owned composer slot between supported placements. */
  setComposerPlacement?(placement: ComposerPlacement, opts?: ComposerPlacementOptions): void;
  /**
   * Called once at the end of ChatRoot's onMount, after all controls and
   * composerSlot are wired. Used by createChatView to fire onViewMounted.
   */
  onMounted?(): void;
};

// ── ChatRootProps ─────────────────────────────────────────────────────────────

export type ChatRootProps = {
  /** Global services: theme, shared caches, measureEpoch, highlighter. */
  context: ChatContext;
  /**
   * Per-conversation state: transcript + parse caches.
   * Accepts either a plain ChatState or a reactive accessor `() => ChatState`
   * (provided by createChatView for the setModel path).
   */
  state: ChatState | (() => ChatState);
  stickToBottom?: boolean;
  /** Extra classes for the full-width scroll container. */
  class?: string;
  /**
   * Classes for the centered content column. Defaults to a max-width column.
   * Rows are measured against this element's width, not the scroll container.
   */
  contentClass?: string;
  /**
   * Enable the layout-boundary debug overlay on every block and row.
   */
  debug?: boolean;
  /**
   * Vertical padding reserved at the top of the canvas (px). Baked into the
   * virtualizer coordinate space — not CSS padding — so scroll math stays exact.
   * Accepts a static number or a reactive accessor.
   */
  padTop?: number | (() => number);
  /**
   * Vertical padding reserved at the bottom of the canvas (px). The last row
   * rests above this space, keeping content clear of a floating composer.
   * When `composer === 'slot'` this is driven automatically by the slot's
   * ResizeObserver; pass a static value only for non-slot hosts.
   * Accepts a static number or a reactive accessor.
   */
  padBottom?: number | (() => number);
  /**
   * Reactive accessor returning the current ChatCommands. Provided by
   * createChatView via a signal so setCommands can update them without remounting.
   */
  commands?: () => ChatCommands;
  /** Fired when the user scrolls near the top and the engine has run out of history. */
  onReachStart?: () => void;
  /** Fired when the "at bottom" sticky state changes. */
  onAtBottomChange?: (atBottom: boolean) => void;
  /**
   * Fired when the latest user message's viewport visibility changes.
   * `true`  = the message body (or any part of it) intersects the viewport.
   * `false` = the message has scrolled fully out of view in either direction.
   * Useful for gating a scroll-to-bottom affordance on the most semantically
   * meaningful scroll position rather than the generic at-bottom threshold.
   */
  onActiveUserMessageVisibilityChange?: (visible: boolean) => void;
  /**
   * Mutable holder that ChatRoot.onMount populates with imperative scroll
   * methods and the composer slot reference.
   */
  controls?: EngineControls;
  /**
   * When true, the active turn's user message is pinned to the top of the
   * transcript while scrolling. Defaults to false.
   */
  pinUserMessages?: boolean;
  /**
   * Controls whether ChatRoot renders an internal composer slot.
   * - `'slot'`: render a sticky bottom slot; internal ResizeObserver drives padBottom.
   * - `'none'` (default): no slot; host controls padBottom externally.
   */
  composer?: 'slot' | 'none';
  /**
   * Initial or reactive composer placement when `composer === 'slot'`.
   * Defaults to `'bottom'`.
   */
  composerPlacement?: ComposerPlacement | (() => ComposerPlacement);
  /**
   * When true, render an absolutely-positioned overlay slot above the
   * transcript/scroll but below the composer (z-index 15). Hosts portal
   * loading/empty/disabled states into `controls.contentOverlay`.
   */
  contentOverlay?: boolean;
  /**
   * A few rows drawn inside another page (the phone's thinking row and delivery card), not a page of its own:
   * no page gutter on the sides and no page padding above and below. Those belong to a transcript that is
   * the page; carried into a host's column they show up as an extra indent and blank bands around each row
   * (2026-10-02 phone: 16px gutter + 32px above + 32px below every embedded row).
   */
  embedded?: boolean;
};

// ── ChatRoot ──────────────────────────────────────────────────────────────────

export function ChatRoot(props: ChatRootProps) {
  // Normalize state prop to an accessor so ChatRoot is reactive when the host
  // swaps models via view.setModel(). Plain ChatState objects (the common path)
  // are wrapped in a stable closure that never changes its value.
  const state: () => ChatState =
    typeof props.state === 'function' ? props.state : () => props.state as ChatState;

  // Assemble the full ChatCaches bundle from context (shared) + state (parse).
  // Leaf components (Code.tsx, Diff.tsx) consume this via useCaches().
  // Memo so it recomputes when the model swaps (new parseCaches).
  const caches = createMemo<ChatCaches>(() => ({
    ...props.context.sharedCaches,
    ...state().parseCaches,
  }));

  // CSS vars — set once at creation time (color changes are CSS-variable themed).
  // The theme is read reactively: `ChatContext.setLayout` swaps it and bumps measureEpoch (#4874).
  const scrollElStyle = (() => {
    const tv = props.context.theme.themeVars;
    const style: Record<string, string> = {};
    for (const k of Object.keys(tv) as ThemeVarKey[]) {
      const ref = String(vars[k as keyof typeof vars]);
      style[ref.startsWith('var(') ? ref.slice(4, -1) : ref] = tv[k];
    }
    return style;
  })();
  const theme = () => props.context.theme;
  const contentClass = () => props.contentClass ?? DEFAULT_CONTENT_CLASS;
  const commands = () => props.commands?.() ?? {};
  const editingMessage = () => commands().editingMessage;
  const [composerPlacement, setComposerPlacementSignal] = createSignal<ComposerPlacement>(
    resolveComposerPlacement(props.composerPlacement)
  );
  const [composerAnimating, setComposerAnimating] = createSignal(false);
  const effectiveComposerPlacement = () =>
    props.composer === 'slot' ? composerPlacement() : 'bottom';

  const pagePadding = () => (props.embedded ? 0 : TRANSCRIPT_VERTICAL_PADDING);
  const padTop = () => {
    const v = props.padTop;
    return (v === undefined ? 0 : typeof v === 'function' ? v() : v) + pagePadding();
  };

  // padBottom signal: either driven by the composer slot ResizeObserver (when
  // composer === 'slot') or by the external padBottom prop.
  // TRANSCRIPT_VERTICAL_PADDING is added on both paths so there is always
  // 32px of breathing room below the last row. Slot hosts also reserve the
  // painted edge fade, so the last line remains fully readable above it.
  const [slotPadBottom, setSlotPadBottom] = createSignal(0);
  const padBottom = () => {
    if (props.composer === 'slot') return slotPadBottom() + pagePadding()
      + (effectiveComposerPlacement() === 'bottom' ? CHAT_COMPOSER_EDGE_FADE_PX : 0);
    const v = props.padBottom;
    return (v === undefined ? 0 : typeof v === 'function' ? v() : v) + pagePadding();
  };

  const inheritedDebug = useContext(DebugContext);
  const debugValue = () => props.debug ?? inheritedDebug();

  // View state — owned by ChatState so it persists across view remounts.
  // All three are accessor functions so they always target the CURRENT model.
  const viewState = () => state().viewState;
  const expandedUserId = () => state().expandedUserId.get();
  const setExpandedUserId = (id: string | null) => state().expandedUserId.set(id);

  let scrollEl: HTMLDivElement | undefined;
  let canvasEl: HTMLDivElement | undefined;
  let outerEl: HTMLDivElement | undefined;
  // Zero-height probe that carries contentClass; the width ResizeObserver
  // targets this so it only fires on genuine layout-width changes.
  let widthProbeEl: HTMLDivElement | undefined;
  let composerSlotLayerEl: HTMLDivElement | undefined;
  let heroSlotEl: HTMLElement | undefined;
  let composerSlotEl: HTMLElement | undefined;
  let contentOverlaySlotEl: HTMLElement | undefined;
  const virt = new Virtualizer();
  // Visible row wrapper elements keyed by unit index.
  const rowEls = new Map<number, HTMLDivElement>();

  const [totalHeight, setTotalHeight] = createSignal(0);
  const [scrollVelocity, setScrollVelocity] = createSignal(0);
  const [viewHeight, setViewHeight] = createSignal(600);
  const [containerWidth, setContainerWidth] = createSignal(0);

  const updateContentColumnGeometry = () => {
    if (!widthProbeEl) return;
    const probeRect = widthProbeEl.getBoundingClientRect();
    if (probeRect.width <= 0) return;
    setContainerWidth(probeRect.width);
  };

  const updateSlotPadBottom = () => {
    if (props.composer !== 'slot' || effectiveComposerPlacement() === 'center') {
      setSlotPadBottom(0);
      return;
    }
    setSlotPadBottom(composerSlotEl?.getBoundingClientRect().height ?? 0);
  };

  const setComposerPlacement = (
    placement: ComposerPlacement,
    opts: ComposerPlacementOptions = {}
  ) => {
    if (props.composer !== 'slot') {
      setComposerPlacementSignal(placement);
      setSlotPadBottom(0);
      return;
    }

    const current = untrack(composerPlacement);
    if (current === placement) {
      updateSlotPadBottom();
      return;
    }

    const first = composerSlotEl?.getBoundingClientRect();
    setComposerPlacementSignal(placement);
    updateSlotPadBottom();

    if (!opts.animate || !composerSlotLayerEl || !composerSlotEl || !first) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    const last = composerSlotEl.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;

    const layer = composerSlotLayerEl;
    setComposerAnimating(false);
    layer.style.transition = 'none';
    layer.style.transform = `translate(${dx}px, ${dy}px)`;
    // Force layout so the inverted transform is committed before animating home.
    void layer.offsetHeight;
    layer.style.transition = '';
    setComposerAnimating(true);

    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      layer.removeEventListener('transitionend', cleanup);
      layer.style.transform = '';
      setComposerAnimating(false);
    };

    layer.addEventListener('transitionend', cleanup);
    window.setTimeout(cleanup, 560);
    requestAnimationFrame(() => {
      layer.style.transform = '';
    });
  };

  // measureEpoch comes from ChatContext so all views share one epoch signal.
  // When fonts load, ChatContext bumps it and all views re-measure.
  const measureEpoch = props.context.measureEpoch;

  createEffect(() => {
    if (typeof props.composerPlacement !== 'function') return;
    const next = props.composerPlacement();
    if (next !== composerPlacement()) {
      setComposerPlacement(next, { animate: false });
    }
  });

  createEffect(() => {
    effectiveComposerPlacement();
    updateSlotPadBottom();
  });

  const refreshTotal = () => {
    setTotalHeight(virt.total());
  };

  // ── Geometry shadow ───────────────────────────────────────────────────────
  //
  // activeTurnReserve: the min-height of the active turn's response region,
  // expressed as trailing canvas space. When the tail of content (from the last
  // user message to the end) is shorter than the viewport, the reserve expands
  // maxScrollTop so projectAnchor('anchor'/'top') can place the user message at the
  // top. As the agent streams a response, tailHeight grows, reserve shrinks,
  // and once the tail fills the viewport reserve is 0 (normal scrolling).
  //
  // INVARIANT: derives from virt.total() (real measured heights) and is added
  // only in contentH — never fed back into virt — so there is no feedback loop
  // and the heightmap is never polluted with reserve padding.
  //
  // Gated by pinUserMessages so views that don't need this behavior are unaffected.
  // lastUserUnitIdx() is memoized on transcript changes, not per streaming tick.
  const activeTurnReserve = () => {
    if (!props.pinUserMessages) return 0;
    const currentState = state();
    const hasUncommittedTurn =
      currentState.transcript.state.activeTurnSnapshot !== null ||
      currentState.session.state.pendingPrompt !== null;
    if (!hasUncommittedTurn) return 0;
    const idx = lastUserUnitIdx();
    if (idx < 0) return 0;
    const tailHeight = totalHeight() - virt.top(idx);
    // Subtract padBottom (composer height + TRANSCRIPT_VERTICAL_PADDING) so the
    // reserve grants exactly enough room to bring the user message flush to the
    // top edge, not past it. Without this, a short agent response allows the
    // user message to over-scroll into blank space below the composer.
    return Math.max(0, viewHeight() - padBottom() - tailHeight);
  };

  const contentH = () => totalHeight() + padTop() + padBottom() + activeTurnReserve();
  const maxScrollTop = () => Math.max(0, contentH() - viewHeight());

  // ── Flat unit view (two-tier, incremental) ────────────────────────────────
  const segmentCtx = (active = false) => segmentCtxFor(props.context, state(), caches(), active);

  let committedUnitsArr: ReturnType<typeof flattenTier> = [];
  // O(1) lookup: itemId -> index of the FIRST unit for that item in the
  // committed tier. Maintained in lock-step with committedUnitsArr. Active-tier
  // items are handled by a small scan in firstUnitIndexOf since activeTurn is
  // always short (≤ a handful of items per streaming turn).
  const committedIndexById = new Map<string, number>();
  // The calendar day the committed tier ends on — the `prevDayKey` seed for the
  // active tier. Maintained in lock-step with committedUnitsArr, exactly like
  // the prevKind seam: without it every new active turn would re-announce a day
  // separator for a day that is already on screen.
  let committedDayKey: string | undefined;
  let lastCommitted: readonly TranscriptTurn[] = [];
  // Identity of the model this effect last built from. A change signals a
  // view.setModel swap and drives the snapshot + incremental-cache reset.
  let lastState: ChatState | undefined;
  const [committedUnitsVersion, setCommittedUnitsVersion] = createSignal(0);
  // Stable empty array passed to makeUnitsView when we need a committed-only
  // view. Must not change identity so memos don't re-run on each access.
  const NO_ACTIVE_UNITS: ReturnType<typeof flattenTier> = [];

  // ── Committed-tier build + model-swap reset (single effect) ────────────────
  // This effect owns BOTH the incremental committed build and the model-swap
  // reset. They were previously split across two effects that relied on Solid
  // running them in creation order; that assumption is unsafe — Solid notifies
  // effects in observer (subscription) order, which shifts as each effect
  // re-subscribes to state() on every run. On a fast tab swap the reset could
  // run AFTER the rebuild and wipe the freshly built committedUnitsArr, leaving
  // an empty transcript until the next named event. Folding both into one
  // computation makes the ordering deterministic: on a state-identity change we
  // snapshot the outgoing model and clear the incremental cache first, then
  // rebuild from the incoming model — all within the same synchronous run.
  createEffect(() => {
    const s = state();
    const next = s.transcript.state.committedTurns;

    if (s !== lastState) {
      // Model swap: snapshot the outgoing model's heights while committedUnitsArr
      // and virt still reflect it, then clear the incremental cache so the build
      // below re-seeds from scratch for the incoming model.
      if (lastState) snapshotInto(lastState);
      // @@@swap-reseeds-virt (#6578) — setCount keeps existing rows: without this the incoming model inherits the outgoing one's row heights.
      virt.setCount(0, () => 0);
      pendingSizeDeltas = [];
      committedUnitsArr = [];
      committedIndexById.clear();
      committedDayKey = undefined;
      lastCommitted = [];
      lastState = s;
    }

    const prev = lastCommitted;
    const ctx = segmentCtx(false);

    if (
      next.length > prev.length &&
      (prev.length === 0 || next[prev.length - 1] === prev[prev.length - 1])
    ) {
      // Incremental append: only process the new tail.
      const tail = next.slice(prev.length);
      const prevKind =
        committedUnitsArr.length > 0
          ? committedUnitsArr[committedUnitsArr.length - 1].kind
          : undefined;
      const newUnits = flattenTier(tail, ctx, SEGMENTERS, UNIT_REGISTRY, prevKind, committedDayKey);
      committedDayKey = trailingDayKey(tail, committedDayKey);
      const base = committedUnitsArr.length;
      for (let j = 0; j < newUnits.length; j++) {
        const u = newUnits[j];
        if (u && !committedIndexById.has(u.itemId)) {
          committedIndexById.set(u.itemId, base + j);
        }
      }
      committedUnitsArr = [...committedUnitsArr, ...newUnits];
    } else {
      // Full rebuild (seed, prepend, or non-append structural change).
      committedUnitsArr = flattenTier(next, ctx, SEGMENTERS, UNIT_REGISTRY);
      committedDayKey = trailingDayKey(next);
      committedIndexById.clear();
      for (let i = 0; i < committedUnitsArr.length; i++) {
        const u = committedUnitsArr[i];
        if (u && !committedIndexById.has(u.itemId)) {
          committedIndexById.set(u.itemId, i);
        }
      }
    }

    lastCommitted = next;
    setCommittedUnitsVersion((v) => v + 1);
  });

  const activeUnits = createMemo(() => {
    committedUnitsVersion();
    const at = state().transcript.state.activeTurnSnapshot;
    const pendingPrompt = state().session.state.pendingPrompt;
    // ⚠️ 有「当前状态」要说时这一档不能空手返回 —— 那一行就贴在这一档的末尾。
    // 没有活动轮也没有待发提示时，它是这一档**唯一**的一行（会话起不来时正是这种情形）。
    const condition = state().session.state.condition;
    if ((!at || at.items.length === 0) && !pendingPrompt && !condition)
      return [] as ReturnType<typeof flattenTier>;
    if ((!at || at.items.length === 0) && !pendingPrompt) {
      return flattenTier(
        [],
        segmentCtx(true),
        SEGMENTERS,
        UNIT_REGISTRY,
        committedUnitsArr.length > 0
          ? committedUnitsArr[committedUnitsArr.length - 1].kind
          : undefined,
        committedDayKey
      );
    }
    const prevKind =
      committedUnitsArr.length > 0
        ? committedUnitsArr[committedUnitsArr.length - 1].kind
        : undefined;
    const activeTurn = at ?? pendingPromptTurn(pendingPrompt!);
    return flattenTier(
      [activeTurn],
      segmentCtx(true),
      SEGMENTERS,
      UNIT_REGISTRY,
      prevKind,
      committedDayKey
    );
  });

  let pendingPromptCommittedTurns = state().transcript.state.committedTurns;
  createEffect(() => {
    const s = state();
    const pendingPrompt = s.session.state.pendingPrompt;
    const committedTurns = s.transcript.state.committedTurns;
    const hasActiveTurn = s.transcript.state.activeTurnSnapshot !== null;
    if (pendingPrompt && (hasActiveTurn || committedTurns !== pendingPromptCommittedTurns)) {
      s.session.setPendingPrompt(null);
    }
    pendingPromptCommittedTurns = committedTurns;
  });

  const units = createMemo<UnitsView>(() => {
    committedUnitsVersion();
    return makeUnitsView(committedUnitsArr, activeUnits());
  });

  /**
   * 「跑完后的最后一条回复」—— 整个转录里唯一带页脚(复制按钮)的那条(#4981)。
   *
   * 会话还在忙(在流式、等后台子智能体、agent 自发的 cycle 没收口)就没有最终回复:
   * 那时每一段都只是临时片段。忙不忙读的是 runtime 投影的 `isGenerating`,与停止键
   * 亮不亮同源 —— ❌ 不拿「有没有活动轮」自己猜:等后台子智能体那会儿活动轮是空的,
   * 中途那条汇报就会被当成最终回复给上页脚,子智能体一回来又收掉,页面一跳一跳。
   *
   * 还有两条(owner 2026-09-06 截图:「派出」底下出了复制按钮,「这不是在过程中吗」):
   *   · 面板上还有在跑的后台子智能体 ⇒ 没有最终回复,哪怕 runtime 已经说不忙了 ——
   *     花名册与面板那张卡同源,卡还在,人就还在等;
   *   · 最终回复必须是**最后一行**:它后面再吊着任何过程行(子智能体跑完的通知、后续的
   *     工具调用)都说明事情还没完;最后一条消息若是用户的(问完 agent 没答)也没有。
   *     日界行这种装饰不算行。
   */
  const finalReplyId = createMemo<string | null>(() => {
    const s = state();
    if (s.session.state.generating) return null;
    if (s.transcript.state.activeTurnSnapshot !== null) return null;
    if (collectSubagentRoster(s.transcript.state.committedTurns, null, '').length > 0) return null;
    const us = units();
    for (let i = us.length - 1; i >= 0; i--) {
      const u = us.at(i);
      if (!u || u.kind === 'day-separator') continue;
      if (u.kind !== 'message') return null;
      const m = u.data as ChatMessage;
      return m.role === 'assistant' && !m.hookNotice ? u.itemId : null;
    }
    return null;
  });

  const userTopGap = UNIT_REGISTRY.message?.margin?.top ?? 8;

  // ── Write-phase-owned geometry output signals ─────────────────────────────
  // The ONLY write target for the visible-row set. Written exclusively by
  // commit() in the write phase, with a sameRange equality guard so JSX
  // reconciles only on actual changes.
  const [visible, setVisible] = createSignal<number[]>([], { equals: sameRange });

  // Shadow geometry captured at the START of each read phase (before any DOM
  // write). computeVisible/computePin consume these inside the write phase so
  // they never force a layout read in the middle of a write sequence.
  let shadowScrollTop = 0;
  let shadowViewHeight = 600;

  // needsProject: set by onHeightChanged / count-sync whenever geometry changes
  // mid-stream so that a single projectAnchor runs in the write phase instead
  // of one per measured row (the layout-thrash regression fix).
  let needsProject = false;

  // appliedTop: the last placement written for each row element, so commit()
  // skips the DOM write when it hasn't changed.
  const appliedTop = new Map<number, string>();

  /**
   * Places a row at `top`. An ordinary row moves by transform. A pin lane (laneH !== null) is placed
   * by `top` with its turn's height: sticky offsets come from layout positions, and a transform is not
   * one, so a translated lane would stick its row as if the lane sat at the top of the canvas.
   */
  const placeRow = (el: HTMLElement, idx: number, top: number, laneH: number | null) => {
    const key = laneH === null ? `t${top}` : `l${top}:${laneH}`;
    if (appliedTop.get(idx) === key) return;
    appliedTop.set(idx, key);
    el.style.transform = laneH === null ? `translateY(${top}px)` : '';
    el.style.top = laneH === null ? '' : `${top}px`;
    el.style.height = laneH === null ? '' : `${laneH}px`;
  };

  // lastLayout: previous LayoutSnapshot so commit() can diff field-by-field.
  let lastLayout: LayoutSnapshot | null = null;

  // lastVisibleStart/End: mirrors of the last derived visible range, used by
  // the idle prefetch slice (which runs outside the reactive scheduler).
  let lastVisibleStart = 0;
  let lastVisibleEnd = -1;

  // ── Count sync effect ─────────────────────────────────────────────────────
  createEffect(() => {
    const us = units();
    const t = theme();
    untrack(() => {
      const estimateCtx = {
        theme: t,
        width: 0,
        isCollapsed: () => false,
        expanded: () => false,
        caches: caches(),
        measureEpoch: measureEpoch(),
        expandedId: expandedUserId(),
        editingMessage: editingMessage(),
        finalReplyId: finalReplyId(),
      };
      // lastWidth > 0 iff onCleanup wrote a snapshot on a prior dispose.
      // Skip the Map.get pass entirely on cold mounts (empty heightmap).
      const currentState = state();
      const hasHeightmapSnapshot = currentState.heightmap.lastWidth > 0;
      virt.setCount(us.length, (i) => {
        const u = us.at(i);
        if (!u) return 60;
        // A mounted row's reported height first (a row measured before a swap re-seed won't report again, #6578),
        // then the persisted heightmap (no scrollbar drift on remount), then the cheap estimate.
        const live = tweenRegistry.heightOf(u.id);
        if (live !== undefined) return live;
        if (hasHeightmapSnapshot) {
          const snapped = currentState.heightmap.get(u.id);
          if (snapped !== undefined) return snapped;
        }
        const unitDef = UNIT_REGISTRY[u.kind];
        const contentH =
          unitDef?.estimate?.(u.data, estimateCtx, unitDef.vars ?? {}) ??
          genericEstimate(u.data as unknown as ChatItem, estimateCtx);
        return unitReservedHeight(u, contentH);
      });
      refreshTotal();
      // Defer projection to the write phase: projectAnchor will fire once per
      // frame (not once per row) preventing layout thrashing on streaming updates.
      needsProject = true;
    });
  });

  // Width change: do NOT flush caches. The per-block fingerprint
  // (measureEpoch|width|collapsed) already handles width invalidation.
  // richInline cache is width-independent (intrinsic glyph widths).
  // measureEpoch bumps (on font load) invalidate everything globally.

  // ── Pin anchors of the committed tier ─────────────────────────────────────
  // Tracks committedUnitsVersion only — not units() — so it does not recompute
  // on every streaming frame. Committed units are always the
  // [0, committedUnitsArr.length) prefix of the full units() view, so the
  // returned absolute indices remain valid. The active tier's anchors are added
  // in pinAnchors.
  const userTurns = createMemo(() => {
    committedUnitsVersion();
    return collectUserTurnUnits(
      state().transcript.state.committedTurns,
      makeUnitsView(committedUnitsArr, NO_ACTIVE_UNITS)
    );
  });

  // ── Last user message unit index ──────────────────────────────────────────
  // Finds the first unit index (in the full units() view) for the last user-
  // role message. Scans activeTurn first so the reserve picks up the freshly-
  // sent message during streaming (ACP bundles the prompt + response into one
  // activeTurn), then falls back to committed. Used by reservedBottom below.
  //
  // Memoized on committedUnitsVersion + activeTurn identity so it does not
  // recompute on every streaming text patch (only on structural turn changes).
  const lastUserUnitIdx = createMemo(() => {
    committedUnitsVersion();
    const transcript = state().transcript.state;
    let targetId: string | null = null;

    // 1. Scan activeTurn backward for the latest user message.
    const active = transcript.activeTurnSnapshot;
    if (active) {
      for (let i = active.items.length - 1; i >= 0; i--) {
        const item = active.items[i];
        if (
          item &&
          item.kind === 'message' &&
          (item as ChatMessage).role === 'user' &&
          !isDeliveredFromAgent(item)
        ) {
          targetId = item.id;
          break;
        }
      }
    }

    // 1b. 乐观行:发出了、真的那一轮还没开出 —— 它就是最后那一句。底部预留与贴顶都按它算,
    //     与真的那一轮开出后一样,交接时那句话不跳(behavior session-page「打开速度」)。
    if (targetId === null && !active) {
      targetId = state().session.state.pendingPrompt?.id ?? null;
    }

    // 2. Fall back to the last committed user message.
    if (targetId === null) {
      targetId = findLastUserMessageId(transcript.committedTurns);
    }

    if (targetId === null) return -1;

    // 3. Map itemId to its first unit index via the O(1) committed map +
    //    O(activeTurn) scan — no full units() scan needed.
    return firstUnitIndexOf(targetId);
  });

  // ── Pure geometry compute functions (called from write phase only) ─────────
  //
  // These functions read virt, shadow values, and Solid signals lazily (signals
  // are never subscribed inside a rAF callback — they just return cached values).
  // They must NOT write any signals or DOM nodes.

  /**
   * Computes the list of unit indices that should be rendered, using the
   * direction-aware asymmetric overscan and the current shadow scroll geometry.
   */
  function computeVisible(): number[] {
    const st = shadowScrollTop;
    const vh = shadowViewHeight;
    const v = scrollVelocity();
    let before: number;
    let after: number;
    if (v > 0) {
      before = OVERSCAN_TRAILING;
      after = OVERSCAN_LEADING;
    } else if (v < 0) {
      before = OVERSCAN_LEADING;
      after = OVERSCAN_TRAILING;
    } else {
      before = OVERSCAN_BASE;
      after = OVERSCAN_BASE;
    }
    const { start, end } = virt.range(Math.max(0, st - padTop()), vh, before, after);
    const n = units().length;
    const visEnd = Math.min(end, n - 1);
    lastVisibleStart = start;
    lastVisibleEnd = visEnd;
    const arr: number[] = [];
    // The lane covering the viewport top stays mounted even when its row has scrolled out of the
    // range: its user message is the one stuck to the top (see @@@sticky-user-lanes).
    const lane = laneAtTop(st, padTop());
    if (lane >= 0 && lane < start) arr.push(lane);
    for (let i = start; i <= visEnd; i++) arr.push(i);
    return arr;
  }

  /**
   * @@@sticky-user-lanes — a user message sticks to the top while its turn is on screen, and the
   * browser does the sticking. Each user message row (a "pin anchor") is placed in a lane that spans
   * its turn: from its own top to the next anchor's top (the last one: to the end of the content).
   * The row is `position: sticky` inside its lane, so it sticks in the same compositor frame as the
   * scroll and is pushed off by the lane's end, i.e. by the next user message.
   *
   * It used to be a JS-positioned copy outside the scroller, placed from the scroll event in rAF.
   * The compositor scrolls first, so that copy was always a frame behind: one frame of the bubble cut
   * under the tab bar when scrolling down, one frame of the same bubble twice when scrolling up.
   *
   * Anchors: every user message, in the committed tier and in the active tier alike (the optimistic
   * row is the active tier's turn until the real one opens). A running turn can hold several: an
   * inserted message joins the running turn, and a turn held open for background sub-agents takes
   * what is sent meanwhile. Delivered notices are not anchors (collectUserTurnUnits).
   */
  const pinAnchors = createMemo<number[]>(
    () => {
      if (!props.pinUserMessages) return [];
      const s = state();
      const pending = s.session.state.pendingPrompt;
      const active =
        s.transcript.state.activeTurnSnapshot ?? (pending ? pendingPromptTurn(pending) : null);
      if (!active) return userTurns();
      const base = committedUnitsArr.length;
      const inActive = collectUserTurnUnits(
        [active],
        makeUnitsView(activeUnits(), NO_ACTIVE_UNITS)
      ).map((i) => base + i);
      return [...userTurns(), ...inActive];
    },
    [],
    // The active tier is rebuilt on every streaming patch; the anchors only change when a message lands.
    { equals: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]) }
  );
  const pinAnchorSet = createMemo(() => new Set(pinAnchors()));

  /** Lane height of an anchor: up to the next anchor, or to the end of the content. */
  function laneHeight(idx: number): number {
    const anchors = pinAnchors();
    const next = anchors[anchors.indexOf(idx) + 1];
    return (next !== undefined ? virt.top(next) : virt.total()) - virt.top(idx);
  }

  /** The anchor whose lane covers the viewport top (its row is the stuck one), or -1. */
  function laneAtTop(st: number, pt: number): number {
    const anchors = pinAnchors();
    let lo = 0;
    let hi = anchors.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (virt.top(anchors[mid]) + pt <= st) {
        found = anchors[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  /**
   * Returns true if the latest user message's canvas block intersects the
   * current scroll viewport [st, st+vh]. Called from writePhase using the
   * frame's shadow geometry.
   */
  function computeActiveUserVisible(st: number, vh: number, pt: number): boolean {
    const idx = lastUserUnitIdx();
    if (idx < 0) return true; // no user message yet — nothing to chase
    const us = units();
    const itemId = us.at(idx)?.itemId;
    if (!itemId) return true;
    let height = 0;
    for (let ui = idx; ui < us.length; ui++) {
      const u = us.at(ui);
      if (!u || u.itemId !== itemId) break;
      height += virt.size(ui);
    }
    const top = virt.top(idx) + pt;
    const bottom = top + height;
    // Visible if the block intersects the viewport [st, st+vh].
    return top < st + vh && bottom > st;
  }

  // ── Scroll intent (ScrollMode) ────────────────────────────────────────────
  //
  // A declarative intent loaded from ChatState on mount/swap and persisted back
  // ── Scroll anchor (event-sourced intent) ─────────────────────────────────
  //
  // `anchor` is the single source of truth for scroll intent. It changes only
  // on named events: user scroll (readPhase), expand/collapse, send, host
  // setScrollMode, scrollToBottom/scrollToItem. It is NEVER re-derived from
  // geometry on idle frames — that feedback loop is what caused scroll jumps.
  //
  // `expectedScrollTop` tracks the last value we wrote so readPhase can tell
  // a real user scroll (st !== expected) from an idle frame or our own write
  // (st === expected). Deterministic; replaces the old microtask-fragile counter.

  // Structural equality for the anchor signal. Avoids JSON.stringify allocations
  // on every setAnchor call (which happens on every user scroll tick).
  const sameScrollMode = (a: ScrollMode, b: ScrollMode): boolean => {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'anchor' && b.kind === 'anchor') {
      return a.itemId === b.itemId && a.edge === b.edge && a.offset === b.offset;
    }
    return true; // both 'tail'
  };

  // Seeded from the current model's persisted intent (may be default 'tail').
  const [anchor, setAnchorSignal] = createSignal<ScrollMode>(untrack(state).scroll.get(), {
    equals: sameScrollMode,
  });

  // Persist intent to ChatState and update the local signal atomically.
  const setAnchor = (m: ScrollMode) => {
    setAnchorSignal(m);
    state().scroll.set(m);
  };

  // Last scrollTop we wrote. Seeded to 0; adopted from browser-clamped value
  // after each write so clamped positions are never counted as user movement.
  let expectedScrollTop = 0;
  // Sub-pixel remainder of the last above-size compensation that the browser's
  // pixel grid did not store; carried into the next one (see @@@above-compensation).
  let aboveResidue = 0;

  const writeScrollTop = (top: number) => {
    if (!scrollEl) return;
    // Clamp arithmetically: projectAnchor already wrote canvasEl.style.height =
    // contentH() before calling us, so maxScrollTop() matches what the browser
    // would compute. Avoiding the read-back (scrollEl.scrollTop after the write)
    // eliminates the forced layout reflow that the read-back caused. Safe because
    // USER_SCROLL_EPSILON filters any sub-pixel divergence in readPhase.
    const clamped = Math.max(0, Math.min(top, maxScrollTop()));
    scrollEl.scrollTop = clamped;
    expectedScrollTop = clamped;
    aboveResidue = 0;
    // Arm the scheduler so the write phase re-derives the visible set for the
    // new scroll position (the scroll event may not fire for programmatic sets).
    scheduler.request();
  };

  // O(1) lookup: first unit index for the given itemId.
  // Committed tier uses committedIndexById (maintained in lock-step with
  // committedUnitsArr); active tier falls back to a small linear scan
  // (activeTurn is always short — typically ≤ 5 units per streaming turn).
  // Called from projectAnchor every frame when intent is 'anchor', and from
  // lastUserUnitIdx. Declared as a function (not const) so it is hoisted and
  // accessible from memos created earlier in the component body.
  function firstUnitIndexOf(id: string): number {
    const committedIdx = committedIndexById.get(id);
    if (committedIdx !== undefined) return committedIdx;
    const active = untrack(activeUnits);
    const base = committedUnitsArr.length;
    for (let i = 0; i < active.length; i++) {
      if (active[i]?.itemId === id) return base + i;
    }
    return -1;
  }

  function unitIndexOf(id: string, edge: 'top' | 'bottom' = 'top'): number {
    let i = firstUnitIndexOf(id);
    if (i < 0 || edge === 'top') return i;
    // Bottom anchors refer to the whole source item, including every unit.
    const us = units();
    while (us.at(i + 1)?.itemId === id) i++;
    return i;
  }

  // The ONE function that writes scrollTop. Flush canvas height first so the
  // browser never clamps scrollTop to a stale (outgoing) canvas height — this
  // is the root cause of "open at top after tab switch".
  const projectAnchor = (m: ScrollMode) => {
    if (!scrollEl) return;
    // Synchronously update canvas height so scrollTop is never clamped.
    if (canvasEl) canvasEl.style.height = `${contentH()}px`;

    if (m.kind === 'anchor') {
      const i = unitIndexOf(m.itemId, m.edge);
      if (i >= 0) {
        const rowTop = virt.top(i) + padTop();
        const target =
          m.edge === 'top' ? rowTop + m.offset : rowTop + virt.size(i) - viewHeight() + padBottom() + m.offset;
        const next = Math.max(0, target);
        // Sub-pixel no-op guard: if the settle correction is smaller than 1 px
        // (anchor already matches the current position), skip the write so the
        // browser thumb is never perturbed by a near-zero adjustment.
        // Compare against expectedScrollTop (our last written value) rather than
        // reading scrollEl.scrollTop to preserve the no-DOM-read-in-write-phase
        // invariant established by Option B.
        if (Math.abs(next - expectedScrollTop) < 1) return;
        writeScrollTop(next);
        return;
      }
      // Anchor item not found (transcript not yet loaded); fall through to tail.
    }
    // tail mode (or anchor item not found yet): re-pin to end.
    if (props.stickToBottom !== false) {
      writeScrollTop(maxScrollTop());
    }
  };

  // ── Per-frame height coalescing ───────────────────────────────────────────
  let totalDirty = false;

  const queueTotalFlush = () => {
    if (totalDirty) return;
    totalDirty = true;
    scheduler.request();
  };

  // ── onHeightChanged — deferred (no per-row DOM read) ─────────────────────
  // Sets needsProject instead of calling projectAnchor synchronously so that
  // N row-height changes during a scroll sweep produce at most ONE projectAnchor
  // (and thus at most ONE forced reflow) in the write phase per rAF frame.
  // This collapses the per-row layout-thrash regression from the scroll rework.
  const onHeightChanged = (index: number, delta: number) => {
    if (delta === 0) return;
    pendingSizeDeltas.push([index, delta]);
    queueTotalFlush();
    needsProject = true;
    scheduler.request();
  };

  // @@@above-compensation (#6401) — 视口之上的尺寸变化只做等量 scrollTop 补偿,与原生 scroll anchoring 同语义。
  // 它不是意图重判定 / 重投影:不改 anchor,不受 SCROLL_SETTLE_MS 闸(落定窗口只管 tail/锚的重新判定)。
  // 从前窗口内晚到的量高(视口之上、渲染窗口之外)没人补,读者看到内容整块跳一下,约 120ms 后投影才补回
  // (负载下实测 426px)。补偿在 commit 新 canvas 高度的同一帧、绘制之前写 ⇒ 没有一帧画出「已长高未补偿」。
  // 仍只经 writeScrollTop 写(同时更新 expectedScrollTop ⇒ readPhase 不会把它误读成用户滚动)。
  // 参照行:行锚那一行;tail 意图下只在平滑滚动途中取视口上沿那一行(贴底读者由 tail 重投影负责)。
  // 窗口过后 projectAnchor 的目标恰随补偿平移,被 <1px no-op 守卫跳过 —— 与 #3992 的逐输入重投影交换。
  // 尺寸变化在三处进来,各自在「坐标被读或被画」之前结清:两帧之间(预取、展开)→ readPhase 在判定用户滚动、
  // 从当前 virt 重取锚之前;animate 相的 tween → writePhase 开头、投影之前;setVisible 新挂载的行同步量高 →
  // 挂载之后、写任何 transform / pin 之前。漏掉任一处,那一帧就画出位移,或把位移后的布局记成用户的锚。
  // 浏览器把 scrollTop 存在自己的像素栅格上(实测 DPR 1 时 10946.231 → 10946),补偿量却是小数(tween 高度)。
  // 所以写完要读回浏览器真存下的值:expectedScrollTop 以它为准(否则被舍掉的那点残差会在下一次拖动时被算成
  // 用户位移、被锚吸收,逐帧累加 —— CI 实撞 6 帧累计 2px),残差带进下一次补偿(读者那一行误差 < 1 个像素栅格、不累加)。
  let pendingSizeDeltas: Array<readonly [number, number]> = [];
  let lastTopUnitIndex = -1;

  const applyAboveCompensation = () => {
    if (pendingSizeDeltas.length === 0) return;
    const deltas = pendingSizeDeltas;
    pendingSizeDeltas = [];
    if (!scrollEl) return;
    const m = anchor();
    const ref = m.kind === 'anchor' ? unitIndexOf(m.itemId, m.edge) : smoothScrolling ? lastTopUnitIndex : -1;
    if (ref < 0) return;
    let aboveDelta = 0;
    for (const [i, d] of deltas) if (i < ref) aboveDelta += d;
    if (aboveDelta === 0) return;
    // 平移,不是改写:用户还没被 readPhase 读到的那段移动(live − expected)原样保留,仍会被判成用户滚动。
    const live = scrollEl.scrollTop;
    const unread = live - expectedScrollTop;
    const carried = aboveResidue;
    if (canvasEl) canvasEl.style.height = `${contentH()}px`;
    writeScrollTop(live + aboveDelta + carried);
    const stored = scrollEl.scrollTop;
    aboveResidue = expectedScrollTop - stored;
    expectedScrollTop = stored - unread;
    // 平滑滚动的目标是文档坐标:上方长高,目标随之平移,否则落点差一个 aboveDelta(之后再被投影拽一下)。
    if (smoothScrolling && smoothScrollTarget !== undefined) {
      smoothScrollTarget += aboveDelta;
      scrollEl.scrollTo({ top: smoothScrollTarget, behavior: 'smooth' });
      aboveResidue = 0;
    }
    shadowScrollTop = stored;
  };

  // ── Frame scheduler — created EAGERLY (before onMount) ───────────────────
  //
  // Hoisted to component scope so tween arming (from UnitRow createEffects)
  // never hits a null reference. Phases guard on scrollEl for pre-mount safety.
  let reachStartFired = false;
  // Cache to avoid emitting onActiveUserMessageVisibilityChange on every frame.
  // `undefined` means "not yet emitted" — forces an emit on the first writePhase
  // and after every model swap.
  let lastActiveUserVisible: boolean | undefined;
  let lastAtBottom: boolean | undefined;

  // Smooth-scroll suppression: when a smooth-scroll animation is in flight,
  // intermediate scrollTop updates are browser-driven and must not be treated
  // as user input. While `smoothScrolling` is true, readPhase keeps
  // expectedScrollTop in sync and skips intent re-derivation.
  let smoothScrolling = false;
  let smoothScrollTarget: number | undefined;

  // An instant scroll aborts the browser's smooth scroll where it stands; a step it already queued may still land
  // (see the readPhase smooth branch), so `smoothScrolling` stays on without a target until the reader's own input.
  const abortSmoothScroll = () => {
    if (smoothScrolling && scrollEl) { const at = scrollEl.scrollTop; scrollEl.scrollTop = at; expectedScrollTop = scrollEl.scrollTop; }
    smoothScrollTarget = undefined;
    lastUserScrollAt = 0;
  };

  // performance.now() of the last real user scroll or smooth-scroll animation
  // frame. Projection (projectAnchor) is suppressed until SCROLL_SETTLE_MS ms
  // after this timestamp — covering the whole gesture, not just one frame.
  // Initialised to 0 so the first write-phase call (no prior scroll) is settled.
  let lastUserScrollAt = 0;

  const emitAtBottom = (value: boolean): void => {
    if (value === lastAtBottom) return;
    lastAtBottom = value;
    props.onAtBottomChange?.(value);
  };

  const readPhase = () => {
    const el = scrollEl;
    if (!el) return;
    // Settle size changes that landed between frames against the previous
    // intent before reading intent from virt (a translation: userDelta survives).
    applyAboveCompensation();
    const st = el.scrollTop;
    // Capture shadow values for the write phase. These are stable for the
    // entire frame: computeVisible/computePin consume them without re-reading.
    shadowScrollTop = st;
    shadowViewHeight = viewHeight();
    const userDelta = st - expectedScrollTop;
    setScrollVelocity(userDelta);

    // Smooth-scroll suppression: while a smooth scroll animation is in flight
    // the browser moves scrollTop without user input. Keep expectedScrollTop in
    // sync so we don't misread intermediate frames as user scrolls.
    // Treat animation frames identically to user scrolls for settle-window
    // purposes so projectAnchor never fights an in-flight animation.
    const target = smoothScrollTarget;
    if (smoothScrolling && target !== undefined) {
      lastUserScrollAt = performance.now();
      expectedScrollTop = st;
      if (Math.abs(st - target) < 1) smoothScrolling = false;
      schedulePrefetch();
      return;
    }

    if (smoothScrolling) {
      // No target = aborted by a model swap (#6578): the browser may still land the aborted animation's step on any
      // later frame. Such a delta is absorbed and the new intent re-projected, until the reader's own input (onReaderInput).
      if (Math.abs(userDelta) > USER_SCROLL_EPSILON) {
        expectedScrollTop = st;
        needsProject = true;
      }
    } else if (Math.abs(userDelta) > USER_SCROLL_EPSILON) {
      // Only re-derive intent when the user actually moved the scrollbar.
      // Use USER_SCROLL_EPSILON to filter sub-pixel self-write rounding so the
      // arithmetic clamp in writeScrollTop is never misread as a user scroll.
      lastUserScrollAt = performance.now();
      expectedScrollTop = st;
      const nowAtBottom = maxScrollTop() - st <= STICK_THRESHOLD_PX;
      const prevAnchor = anchor();
      const prevAtBottom = prevAnchor.kind === 'tail';
      if (nowAtBottom) {
        if (!prevAtBottom) {
          setAnchor({ kind: 'tail' });
        }
      } else {
        const pt = padTop();
        const anchorUnitIdx = virt.findIndex(Math.max(0, st - pt));
        const anchorUnit = units().at(anchorUnitIdx);
        if (anchorUnit) {
          setAnchor({
            kind: 'anchor',
            itemId: anchorUnit.itemId,
            edge: 'top',
            offset: st - (virt.top(anchorUnitIdx) + pt),
          });
        }
      }
      emitAtBottom(nowAtBottom);
    }

    if (st <= REACH_START_THRESHOLD_PX) {
      if (!reachStartFired) {
        reachStartFired = true;
        props.onReachStart?.();
      }
    } else {
      reachStartFired = false;
    }

    schedulePrefetch();
  };

  const animatePhase = (): boolean => tweenRegistry.advance(performance.now());

  // ── commit() — single-owner geometry committer ────────────────────────────
  //
  // commit() diffs a new LayoutSnapshot against lastLayout and applies only
  // the changed fields to the DOM / signals. This ensures:
  //   - No DOM read inside the write phase (all reads were in readPhase).
  //   - At most one forced reflow per frame (from projectAnchor if needsProject).
  //   - Zero signal writes on stable frames (snapshot diff + equals guards).

  function commit(next: LayoutSnapshot, nextVisible: number[]): void {
    const prev = lastLayout;

    // Canvas height — write only when changed.
    if (!prev || prev.canvasHeight !== next.canvasHeight) {
      if (canvasEl) canvasEl.style.height = `${next.canvasHeight}px`;
    }

    // Visible set — setVisible uses sameRange so <For> reconciles on changes only.
    setVisible(nextVisible);

    // Row positions — only write what actually changed.
    const pt = padTop();
    const anchors = pinAnchorSet();
    for (const idx of nextVisible) {
      const el = rowEls.get(idx);
      if (el) placeRow(el, idx, virt.top(idx) + pt, anchors.has(idx) ? laneHeight(idx) : null);
    }

    lastLayout = next;
  }

  const writePhase = (): boolean => {
    if (totalDirty) {
      totalDirty = false;
      setTotalHeight(virt.total());
    }
    applyAboveCompensation();
    // Projection is coalesced: at most one projectAnchor per frame (not per row).
    // This is the fix for the per-row layout-thrash perf regression.
    //
    // Gate on a settle window instead of a per-frame flag: if the user scrolled
    // (or a smooth-scroll animation ran) within the last SCROLL_SETTLE_MS, skip
    // the correction so the browser thumb is never fought mid-gesture. This
    // eliminates the in-direction jump that a per-frame gate allowed (any rAF
    // tick landing between scroll events would open the old gate mid-drag).
    // While unsettled, scheduler.request() keeps the loop alive so the
    // projection fires after the window without any further events.
    // request() does not increment the converge counter, so it cannot trip
    // the MAX_CONVERGE halt in the frame scheduler.
    if (needsProject) {
      const settled = performance.now() - lastUserScrollAt > SCROLL_SETTLE_MS;
      if (settled) {
        needsProject = false;
        projectAnchor(anchor());
        // projectAnchor flushed canvas height and wrote scrollTop; re-capture
        // shadow scrollTop so computeVisible/computePin use the projected value.
        if (scrollEl) shadowScrollTop = scrollEl.scrollTop;
      } else {
        scheduler.request();
      }
    }
    const nextVisible = computeVisible();
    // Rows mounting here measure synchronously; settle their deltas before any
    // row position is computed from the new geometry.
    setVisible(nextVisible);
    applyAboveCompensation();
    const pt = padTop();
    const next: LayoutSnapshot = {
      start: nextVisible[0] ?? 0,
      end: nextVisible[nextVisible.length - 1] ?? -1,
      canvasHeight: contentH(),
    };
    commit(next, nextVisible);

    emitAtBottom(maxScrollTop() - shadowScrollTop <= STICK_THRESHOLD_PX);
    lastTopUnitIndex = virt.findIndex(Math.max(0, shadowScrollTop - pt));

    // Emit active-user-message visibility change when the state flips.
    if (props.onActiveUserMessageVisibilityChange) {
      const visible = computeActiveUserVisible(shadowScrollTop, shadowViewHeight, pt);
      if (visible !== lastActiveUserVisible) {
        lastActiveUserVisible = visible;
        props.onActiveUserMessageVisibilityChange(visible);
      }
    }

    return false;
  };

  const scheduler = createFrameScheduler({
    read: readPhase,
    animate: animatePhase,
    write: writePhase,
  });
  onCleanup(() => scheduler.dispose());

  // ── Central tween registry — wired to eager scheduler ────────────────────
  const tweenRegistry = createTweenRegistry(virt, onHeightChanged, {
    requestFrame: () => scheduler.request(),
  });

  // ── Invalidation bridge — the single reactive input list ─────────────────
  //
  // One createEffect reads every layout-affecting signal, marks the projection
  // dirty and calls scheduler.request(). This replaces the per-memo dependency
  // curation that drifted (and caused blank transcripts / stale pins). Any
  // layout input change => one arm, never more, never fewer.
  //
  // @@@project-on-every-layout-input — arming the scheduler alone re-derives the
  // visible set and the canvas height but leaves scrollTop where it was, so an
  // input that moves the END of the canvas silently un-pins a `tail` intent by
  // exactly its own size. padBottom (the composer slot) and viewHeight both
  // arrive from ResizeObservers, i.e. after the frame that projected the tail:
  // the composer is portalled in once history loads, the pane settles its own
  // size around the same time. Neither touches `virt`, so neither is covered by
  // the count-sync / onHeightChanged projections — measured shortfall was one
  // composer height (120px) and one viewport shrink (80px) respectively.
  // The scroll position is a layout output like the others; every input to
  // contentH()/maxScrollTop() re-projects the current intent.
  //
  // Output signals (visible, pin) are intentionally NOT in this list —
  // reading them here would create a feedback loop.
  createEffect(() => {
    // units() already tracks committedUnitsVersion() transitively — no need to
    // list it here separately.
    units();
    totalHeight();
    padTop();
    padBottom();
    viewHeight();
    containerWidth();
    measureEpoch();
    expandedUserId();
    editingMessage();
    finalReplyId();
    needsProject = true;
    scheduler.request();
  });

  // Idle-time prefetch state — referenced by readPhase / schedulePrefetch
  let prefetchIdleId: ReturnType<typeof requestIdleCallback> | null = null;
  let prefetchStart = -1;
  let prefetchEnd = -1;

  const schedulePrefetch = () => {
    if (prefetchIdleId !== null) return;
    prefetchIdleId = requestIdleCallback(runPrefetchSlice, { timeout: 500 });
  };

  const cancelPrefetch = () => {
    if (prefetchIdleId !== null) {
      cancelIdleCallback(prefetchIdleId);
      prefetchIdleId = null;
    }
  };

  const runPrefetchSlice = (deadline: IdleDeadline) => {
    prefetchIdleId = null;

    const visStart = lastVisibleStart;
    const visEnd = lastVisibleEnd;
    const us = units();
    const n = us.length;
    if (n === 0) return;

    const ahead = Math.min(visEnd + PREFETCH_AHEAD, n - 1);
    const behind = Math.max(visStart - PREFETCH_BEHIND, 0);

    if (prefetchStart < 0 || prefetchEnd < 0) {
      prefetchStart = visEnd + 1;
      prefetchEnd = ahead;
    }

    const w = containerWidth();
    const t = theme();

    let measured = 0;

    const prefetchUnit = (ui: number): void => {
      const u = us.at(ui);
      if (!u) return;
      const unitDef = UNIT_REGISTRY[u.kind];
      if (!unitDef) return;
      const c = u.chrome;
      const unitInsetX = c?.insetX ?? 0;
      const ctx: MeasureCtx = {
        theme: t,
        width: Math.max(0, w - 2 * unitInsetX),
        isCollapsed: (id: string) => viewState().isCollapsed(id),
        expanded: (id: string) => viewState().isCollapsed(id),
        caches: caches(),
        measureEpoch: measureEpoch(),
        expandedId: expandedUserId(),
        editingMessage: editingMessage(),
        finalReplyId: finalReplyId(),
      };
      const contentH = unitDef.measure(u.data, ctx, unitDef.vars ?? {});
      const h = unitReservedHeight(u, contentH);
      const delta = virt.setSize(ui, h);
      if (delta !== 0) onHeightChanged(ui, delta);
    };

    while (prefetchStart <= prefetchEnd && deadline.timeRemaining() >= PREFETCH_MIN_REMAINING_MS) {
      prefetchUnit(prefetchStart);
      measured++;
      prefetchStart++;
    }

    if (prefetchStart > prefetchEnd) {
      let backCursor = visStart - 1;
      while (backCursor >= behind && deadline.timeRemaining() >= PREFETCH_MIN_REMAINING_MS) {
        prefetchUnit(backCursor);
        measured++;
        backCursor--;
      }
    }

    if (measured > 0 && prefetchStart <= prefetchEnd) {
      schedulePrefetch();
    }
  };

  // ── Scroll helpers ────────────────────────────────────────────────────────
  const doScrollToTop = (opts?: { behavior?: ScrollBehavior }) => {
    const el = scrollEl;
    if (!el) return;
    const firstUnit = units().at(0);
    if (firstUnit) {
      setAnchor({ kind: 'anchor', itemId: firstUnit.itemId, edge: 'top', offset: -padTop() });
    }
    if (opts?.behavior === 'smooth') {
      smoothScrolling = true;
      smoothScrollTarget = 0;
      el.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      writeScrollTop(0);
    }
  };

  const doScrollToBottom = (opts?: { behavior?: ScrollBehavior }) => {
    const el = scrollEl;
    if (!el) return;
    const target = maxScrollTop();
    setAnchor({ kind: 'tail' });
    if (opts?.behavior === 'smooth') {
      smoothScrolling = true;
      smoothScrollTarget = target;
      el.scrollTo({ top: target, behavior: 'smooth' });
    } else {
      writeScrollTop(target);
    }
  };

  const doScrollToItem = (id: string, opts?: ScrollToItemOptions) => {
    const el = scrollEl;
    if (!el) return;

    const us = units();
    let unitIdx = -1;
    for (let i = 0; i < us.length; i++) {
      if (us.at(i)?.itemId === id) {
        unitIdx = i;
        break;
      }
    }
    if (unitIdx < 0) return;

    let itemTotalH = 0;
    for (let i = unitIdx; i < us.length; i++) {
      if (us.at(i)?.itemId !== id) break;
      itemTotalH += virt.size(i);
    }

    const idx = unitIdx;
    const rowH = itemTotalH;

    const align = opts?.align ?? 'start';
    const extraOffset = opts?.offset ?? 0;
    const behavior = opts?.behavior ?? 'auto';

    const computeTarget = () => {
      const rowTop = virt.top(idx) + padTop();
      const vh = Math.max(0, el.clientHeight - padBottom());
      let target: number;
      if (align === 'center') {
        target = rowTop - (vh - rowH) / 2;
      } else if (align === 'end') {
        target = rowTop - vh + rowH;
      } else {
        target = rowTop;
      }
      return Math.max(0, target + extraOffset);
    };

    const t0 = computeTarget();

    // Keep the requested reading edge anchored. End alignment follows the
    // measured composer height when its draft or attachments resize the slot.
    const anchorUnit = us.at(idx);
    if (anchorUnit) {
      const newOffset = t0 - (virt.top(idx) + padTop());
      setAnchor({
        kind: 'anchor',
        itemId: anchorUnit.itemId,
        edge: align === 'end' ? 'bottom' : 'top',
        offset: align === 'end' ? extraOffset : newOffset,
      });
    }

    if (behavior === 'smooth') {
      smoothScrolling = true;
      smoothScrollTarget = t0;
      el.scrollTo({ top: t0, behavior: 'smooth' });
    } else {
      writeScrollTop(t0);
      requestAnimationFrame(() => {
        const t1 = computeTarget();
        writeScrollTop(t1);
      });
    }
  };

  const doLoadOlder = (turns: TranscriptTurn[]) => {
    const el = scrollEl;
    if (!el || turns.length === 0) return;

    const t = theme();
    // No `prevDayKey`: these turns are older than everything on screen, so the
    // day context genuinely starts fresh here. These units only seed the
    // virtualizer's height estimates — history.prepend() below triggers the
    // authoritative full rebuild, which is what settles the final separator set
    // (the old head's separator may become redundant once an older same-day
    // turn lands above it).
    const prependedUnits = flattenTier(turns, segmentCtx(false), SEGMENTERS, UNIT_REGISTRY);

    const anchorUnitIdx = virt.findIndex(Math.max(0, el.scrollTop - padTop()));
    const anchorId = units().at(anchorUnitIdx)?.itemId;
    const anchorOffset = el.scrollTop - (virt.top(anchorUnitIdx) + padTop());

    const loadEstimateCtx: MeasureCtx = {
      theme: t,
      width: containerWidth(),
      isCollapsed: () => false,
      expanded: () => false,
      caches: caches(),
    };
    const count = prependedUnits.length;
    // 前插改变了所有行号;这一批的锚位由下面按 anchorId 重算,旧的逐行增量作废(行号已失效)。
    pendingSizeDeltas = [];
    virt.prepend(count, (i) => {
      const unit = prependedUnits[i];
      if (!unit) return userTopGap + 60;
      const unitDef = UNIT_REGISTRY[unit.kind];
      const contentH =
        unitDef?.estimate?.(unit.data, loadEstimateCtx, unitDef.vars ?? {}) ??
        genericEstimate(unit.data as unknown as ChatItem, loadEstimateCtx);
      return unitReservedHeight(unit, contentH);
    });

    state().transcript.history.prepend(turns);
    refreshTotal();

    if (anchorId !== undefined) {
      const newUs = units();
      let newUnitIdx = -1;
      for (let i = 0; i < newUs.length; i++) {
        if (newUs.at(i)?.itemId === anchorId) {
          newUnitIdx = i;
          break;
        }
      }
      if (newUnitIdx >= 0) {
        const newTop = virt.top(newUnitIdx) + padTop() + anchorOffset;
        writeScrollTop(newTop);
      }
    }
  };

  // ── Snapshot / restore helpers ────────────────────────────────────────────
  //
  // snapshotInto: persist only the heightmap. The scroll intent (ScrollMode)
  // is already kept current in ChatState by setAnchor() — no extra DOM reads
  // needed here. Called by the dispose onCleanup and by the swap effect.

  function snapshotInto(target: ChatState): void {
    // Use committedUnitsArr (not live units()) so that when this is called from
    // the reset effect (before clearing), it captures the OUTGOING model's unit
    // ids and measured sizes — not the incoming model's (which virt already
    // reflects by the time the swap effect fires). Active-turn units are
    // ephemeral and intentionally excluded; they are re-estimated on next mount.
    const w = untrack(containerWidth);
    const entries: Array<[string, number]> = [];
    for (let i = 0; i < committedUnitsArr.length; i++) {
      const u = committedUnitsArr[i];
      if (u) entries.push([u.id, virt.size(i)]);
    }
    target.heightmap.setAll(entries);
    target.heightmap.lastWidth = w;
    // ScrollMode is already persisted continuously by setAnchor() in readPhase
    // and by host calls to setScrollMode(). No DOM-derived anchor write here.
  }

  // attach: load the intent from a (possibly new) model and project it onto
  // the DOM. Synchronously flushes canvas height before writing scrollTop so
  // the browser never clamps to the outgoing model's stale canvas height —
  // the root cause of "open at top after tab switch".
  function attach(target: ChatState): void {
    const m = target.scroll.get();
    // Update the local signal without persisting (it already IS the canonical value).
    setAnchorSignal(m);
    projectAnchor(m);
  }

  // ── DOM setup ─────────────────────────────────────────────────────────────
  onMount(() => {
    const el = scrollEl!;

    // Populate the controls holder so handle delegates resolve immediately.
    if (props.controls) {
      props.controls.scrollToTop = doScrollToTop;
      props.controls.scrollToBottom = doScrollToBottom;
      props.controls.scrollToItem = doScrollToItem;
      props.controls.loadOlder = doLoadOlder;
      props.controls.toggleCollapsed = (id) => viewState().toggleCollapsed(id);
      props.controls.composerSlot = composerSlotEl ?? null;
      props.controls.heroSlot = heroSlotEl ?? null;
      props.controls.contentOverlay = contentOverlaySlotEl ?? null;
      props.controls.setComposerPlacement = setComposerPlacement;
      // Declarative scroll intent: host sets intent; ChatRoot projects it.
      // A new intent supersedes a smooth scroll still in flight: left armed, the above-compensation would re-aim it
      // at its old target and slide the view there, until the settle window let the projection jump back.
      props.controls.setScrollMode = (m: ScrollMode) => {
        abortSmoothScroll();
        setAnchor(m);
        projectAnchor(m);
      };
      // Notify the view creator that all controls are wired.
      props.controls.onMounted?.();
    }

    const onScroll = () => {
      if (el.offsetParent === null) return;
      scheduler.request();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onCleanup(() => {
      el.removeEventListener('scroll', onScroll);
      cancelPrefetch();
    });

    // Only the reader's own input ends the absorption of a smooth scroll aborted by a model swap: without it,
    // a scroll delta is the browser landing the aborted animation, whichever frame it lands on.
    const doc = el.ownerDocument;
    const onReaderInput = () => {
      if (smoothScrolling && smoothScrollTarget === undefined) smoothScrolling = false;
    };
    const readerInputs = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    for (const type of readerInputs) doc.addEventListener(type, onReaderInput, { capture: true, passive: true });
    onCleanup(() => {
      for (const type of readerInputs) doc.removeEventListener(type, onReaderInput, { capture: true });
    });

    // On dispose: snapshot measured row heights and scroll anchor into ChatState
    // so the next mount can seed the Virtualizer and restore position without
    // scrollbar drift (e.g. when switching conversation tabs).
    onCleanup(() => snapshotInto(state()));

    // @@@view-height-at-mount (#6578) — read now: the RO's first delivery lands after rAF, i.e. after attach() below projected against the 600 seed.
    const syncViewHeight = () => { if (el.clientHeight > 0) setViewHeight(el.clientHeight); };
    const roHeight = new ResizeObserver(syncViewHeight);
    roHeight.observe(el);
    onCleanup(() => roHeight.disconnect());
    syncViewHeight();

    // Target the zero-height probe instead of canvasEl so this observer only fires
    // on genuine column width changes and not on canvas height mutations from
    // streaming/tween updates.
    if (widthProbeEl) {
      const roWidth = new ResizeObserver(() => updateContentColumnGeometry());
      roWidth.observe(widthProbeEl);
      updateContentColumnGeometry();
      onCleanup(() => roWidth.disconnect());
    }

    // Composer slot: measure its height and drive padBottom. Delegates to
    // updateSlotPadBottom so the slot has ONE measurement definition: the
    // observer used contentRect (content box) while setComposerPlacement used
    // getBoundingClientRect (border box), and the slot carries an 8px bottom
    // padding under the same backdrop — so the two paths reserved different
    // amounts for the same strip and the transcript stepped 8px on every
    // placement change.
    if (props.composer === 'slot' && composerSlotEl) {
      const roSlot = new ResizeObserver(() => updateSlotPadBottom());
      roSlot.observe(composerSlotEl);
      onCleanup(() => roSlot.disconnect());
    }

    const onClick = (e: Event) => {
      const t = e.target as HTMLElement;

      const userCard = t.closest('[data-user-card]') as HTMLElement | null;
      if (userCard?.dataset.userCard) {
        const id = userCard.dataset.userCard;
        if (expandedUserId() !== id) {
          setExpandedUserId(id);
        }
        return;
      }

      const collapseTarget = t.closest('[data-collapse-id]') as HTMLElement | null;
      if (collapseTarget?.dataset.collapseId) {
        const id = collapseTarget.dataset.collapseId;
        // Pin the toggled row at its current viewport position before the height
        // change. With readPhase no longer reclassifying intent on idle frames,
        // this anchor is now guaranteed to survive the tween — fixing the scroll
        // jump on expand/collapse in short reserve-active transcripts.
        // ⚠️ 开关的 id 与它所在那一行的 unit id **未必是同一个**:带命名空间后缀的开关
        // (`${turnId}:outcome-detail`、`${turnId}:discarded`)在 `unitIndexOf` 里查不到 ⇒
        // `idx < 0` ⇒ 锚点没设上 ⇒ 点开视口上方的一行时,transcript 会在读者眼皮底下跳。
        // ⇒ 让开关自己说出「我住在哪一行」(`data-collapse-anchor`),没说的照旧用 id 本身。
        const anchorId = collapseTarget.dataset.collapseAnchor ?? id;
        const idx = unitIndexOf(anchorId);
        if (idx >= 0 && scrollEl) {
          const offset = scrollEl.scrollTop - (virt.top(idx) + padTop());
          setAnchor({ kind: 'anchor', itemId: anchorId, edge: 'top', offset });
        }
        viewState().toggleCollapsed(id);
        return;
      }

      if (expandedUserId() !== null) {
        setExpandedUserId(null);
      }
    };
    const clickTarget = outerEl ?? el;
    clickTarget.addEventListener('click', onClick);
    onCleanup(() => clickTarget.removeEventListener('click', onClick));

    // Visibility watchdog: self-heal any missed wakes when pane becomes visible.
    if (typeof document !== 'undefined') {
      const onVisibilityChange = () => {
        if (!document.hidden) {
          scheduler.forceReconcile(() => {
            totalDirty = true;
          });
        }
      };
      document.addEventListener('visibilitychange', onVisibilityChange);
      onCleanup(() => document.removeEventListener('visibilitychange', onVisibilityChange));
    }

    // Attach to the initial model: load its persisted scroll intent and project
    // it onto the DOM. Flushes canvas height first so scrollTop is never clamped.
    attach(state());

    // ── Model-swap effect (view.setModel path) ────────────────────────────
    // The committed-tier effect snapshots the outgoing model and resets virt; this effect may run
    // before count-sync re-seeds it (#6578), so it only loads the incoming intent and leaves the
    // projection to the next write phase — no paint can happen before that rAF.
    createEffect(
      on(
        state,
        (next) => {
          // Reset visibility cache so the next writePhase re-emits for the new
          // conversation, even if the boolean value happens to be the same.
          lastActiveUserVisible = undefined;
          lastAtBottom = undefined;
          setAnchorSignal(next.scroll.get());
          // A gesture or smooth scroll on the outgoing model must not hold this projection back.
          abortSmoothScroll();
          needsProject = true;
          scheduler.forceReconcile(() => {
            totalDirty = true;
          });
        },
        { defer: true }
      )
    );

    // Force an initial reconcile pass so the scheduler runs once on attach.
    scheduler.forceReconcile(() => {
      totalDirty = true;
    });
  });

  // ── Active-turn id set ────────────────────────────────────────────────────
  const activeTurnItemIds = createMemo(() => {
    const active = state().transcript.state.activeTurnSnapshot;
    const ids = new Set(active?.items.map((i) => i.id) ?? []);
    const pendingPrompt = state().session.state.pendingPrompt;
    if (pendingPrompt) ids.add(pendingPrompt.id);
    return ids;
  });

  const currentMessageId = createMemo<string | null>(() => {
    return findLastUserMessageId(state().transcript.state.committedTurns);
  });

  const turnStatus = () => state().transcript.state.turnStatus;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <ChatTranslationProvider value={props.context.translate}>
      <SelfIdentityProvider value={props.context.selfIdentity}>
      <SenderAvatarProvider value={props.context.senderAvatar}>
      <AppNameProvider value={props.context.appName}>
      <DebugContext.Provider value={debugValue}>
        <ThemeContext.Provider value={theme}>
        <CachesContext.Provider value={caches()}>
          <CommandsContext.Provider value={commands}>
            <TurnStateContext.Provider value={{ currentMessageId, turnStatus }}>
              <div
                ref={(el) => {
                  outerEl = el;
                }}
                data-chat-root
                data-chat-layout={theme().layout.preset}
                class={outerClip}
                style={scrollElStyle}
              >
                <div
                  ref={(el) => {
                    scrollEl = el;
                  }}
                  data-chat-scroll
                  class={`${scrollContainer}${props.embedded ? ` ${scrollContainerEmbedded}` : ''}${props.class ? ` ${props.class}` : ''}`}
                >
                  {/* Zero-height probe: same max-width cap as rows; the width
                      ResizeObserver targets this to isolate layout-width changes
                      from canvas height mutations (streaming / tween updates). */}
                  <div
                    ref={(el) => {
                      widthProbeEl = el;
                    }}
                    data-chat-width-probe
                    aria-hidden="true"
                    class={`${widthProbeClass} ${contentClass()}`}
                  />
                  <div
                    ref={(el) => {
                      canvasEl = el;
                      el.style.height = `${contentH()}px`;
                    }}
                    data-chat-canvas
                    class={`${canvas} ${contentClass()}`}
                  >
                    <For each={visible()}>
                      {(unitIndex) => {
                        const u = () => units().at(unitIndex);
                        const isActiveTurn = () => {
                          const unit = u();
                          return unit ? activeTurnItemIds().has(unit.itemId) : false;
                        };
                        const isPinAnchor = () => pinAnchorSet().has(unitIndex);

                        return (
                          <Show when={u()}>
                            <div
                              class={unitRowWrapper}
                              classList={{ [pinLane]: isPinAnchor() }}
                              ref={(el) => {
                                rowEls.set(unitIndex, el);
                                // Seed the placement; commit() reconciles on each frame.
                                placeRow(el, unitIndex, virt.top(unitIndex) + padTop(), untrack(isPinAnchor) ? laneHeight(unitIndex) : null);
                                onCleanup(() => {
                                  rowEls.delete(unitIndex);
                                  appliedTop.delete(unitIndex);
                                });
                              }}
                              data-index={String(unitIndex)}
                            >
                              {/* Stuck with the card on the pin line whatever this row's collapsed top gap is. */}
                              <div
                                classList={{ [pinSticky]: isPinAnchor() }}
                                style={isPinAnchor() ? { top: `${userTopGap - (u()?.gapBefore ?? 0)}px` } : undefined}
                              >
                              <UnitRow
                                unit={u()!}
                                index={unitIndex}
                                rowWidth={containerWidth()}
                                theme={theme()}
                                viewState={viewState()}
                                virt={virt}
                                onHeightChanged={onHeightChanged}
                                tweenRegistry={tweenRegistry}
                                isActiveTurn={isActiveTurn()}
                                caches={caches()}
                                measureEpoch={measureEpoch()}
                                expandedId={expandedUserId()}
                                editingMessage={editingMessage()}
                                finalReplyId={finalReplyId()}
                              />
                              <Show when={isPinAnchor()}>
                                {/* Signals that rows scroll beneath the stuck message; drawn only while stuck. */}
                                <div class={pinFade} aria-hidden="true" />
                              </Show>
                              </div>
                            </div>
                          </Show>
                        );
                      }}
                    </For>
                  </div>
                </div>
                {/* Content overlay slot: absolute cover above transcript/scroll,
                    below the composer (z-index 15). Hosts portal loading/empty/
                    disabled states into this element. */}
                <Show when={props.contentOverlay}>
                  <div
                    ref={(el) => {
                      contentOverlaySlotEl = el;
                    }}
                    class={contentOverlaySlotClass}
                  />
                </Show>
                {/* Composer slot: full-width positioning layer; the inner
                    centered div is what the host portals its React composer
                    into, and what the ResizeObserver measures for padBottom. */}
                <Show when={props.composer === 'slot'}>
                  <div
                    ref={(el) => {
                      composerSlotLayerEl = el;
                    }}
                    data-chat-composer-placement={effectiveComposerPlacement()}
                    class={`${effectiveComposerPlacement() === 'center' ? composerSlotCenteredClass : composerSlotClass}${composerAnimating() ? ` ${composerSlotAnimatingClass}` : ''}`}
                  >
                    <div
                      ref={(el) => {
                        heroSlotEl = el;
                      }}
                      class={`${heroSlotClass} ${effectiveComposerPlacement() === 'center' ? heroSlotVisibleClass : heroSlotHiddenClass}`}
                    />
                    <div
                      ref={(el) => {
                        composerSlotEl = el;
                      }}
                      class={`${composerSlotInnerClass} ${effectiveComposerPlacement() === 'center' ? composerSlotInnerCenteredClass : composerSlotInnerBottomClass}`}
                    />
                  </div>
                </Show>
              </div>
            </TurnStateContext.Provider>
          </CommandsContext.Provider>
        </CachesContext.Provider>
        </ThemeContext.Provider>
      </DebugContext.Provider>
      </AppNameProvider>
      </SenderAvatarProvider>
      </SelfIdentityProvider>
    </ChatTranslationProvider>
  );
}
