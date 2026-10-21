/**
 * createTweenRegistry — central height-tween store advanced by the frame scheduler.
 *
 * Replaces per-row createHeightTween rAF loops with a single registry that is
 * advanced once per frame in the scheduler's animate phase. All tween logic
 * (easing, shouldAnimate gate, reduced-motion snap, retarget mid-flight) is
 * preserved from create-height-tween.ts.
 *
 * Key design points:
 * - Entries are keyed by the **unique unit key** — `unit.id`, not the row index
 *   and NOT the source `itemId` — so they survive re-flatten (prepend / reorder
 *   operations that shift row indices) while still belonging to exactly one row.
 *   One entry must have exactly one writer: two rows claiming one key overwrite
 *   each other's target and took the renderer down with them (#5332).
 * - Each entry owns a pair of SolidJS signals (height, animating) created in
 *   an isolated owner root that is disposed on unregister.
 * - UnitRow registers its target via `registry.set(key, getIndex, target,
 *   shouldAnimate)` from a reactive effect; the registry detects target changes
 *   and decides snap-vs-animate the same way createHeightTween did. `set()` is a
 *   writer: it reads its own entry untracked so the calling effect never ends up
 *   subscribed to the signal it writes.
 * - `advance(now)` is called by the frame scheduler; it interpolates all active
 *   entries, calls virt.setSize + onHeightChanged, and returns true while any
 *   entry is still animating so the scheduler stays awake.
 * - `set()` returns a TweenHandle — the `height` / `animating` / `clipHeight`
 *   accessors UnitRow builds its RenderCtx from. The registry itself exposes
 *   only set / unregister / advance.
 */

import type { Virtualizer } from '@session-chat/core/virtualizer';
import { createRoot, createSignal, untrack } from 'solid-js';
import type { Accessor, Setter } from 'solid-js';
import { collapseAnimationDefaults } from './create-height-tween';

// ── Easing ────────────────────────────────────────────────────────────────────

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

// ── Reduced-motion detection ──────────────────────────────────────────────────

function defaultReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type TweenEntry = {
  /** Current tween start value (height at the moment the target changed). */
  from: number;
  /** Target height we are interpolating toward. */
  to: number;
  /** Timestamp (ms) when this tween started. */
  startTime: number;
  /** Whether a tween is currently in-flight for this entry. */
  active: boolean;
  /** Returns the current row index — may change across re-flattens. */
  getIndex: () => number;
  /** Reactive signal getter — read by UnitRow to drive layout. */
  height: Accessor<number>;
  setHeight: Setter<number>;
  /** Reactive signal getter — read by UnitRow to drive clip/display state. */
  animating: Accessor<boolean>;
  setAnimating: Setter<boolean>;
  /** Disposes the isolated SolidJS owner that owns the signals. */
  disposeOwner: () => void;
  /**
   * Whoever most recently claimed this key. `unregister` refuses to delete an
   * entry owned by someone else, so a row leaving a key cannot destroy the entry
   * a different, still-live row has already taken over (#5332).
   */
  claimant?: object;
};

export type TweenHandle = {
  /** Animated height reactive accessor — use for virt.setSize. */
  height: Accessor<number>;
  /** True while a tween is in progress. */
  animating: Accessor<boolean>;
  /**
   * Animated content-clip height. Non-null only while animating; use to clip
   * the content container and track card borders through the tween.
   * `gapBefore` is subtracted to convert row-reserved height to content height.
   */
  clipHeight: (gapBefore: number) => number | null;
};

export type TweenRegistry = {
  /**
   * Called by UnitRow (from a reactive effect) whenever the row's logical
   * reserved height or expand state changes. The registry detects a target
   * change and decides whether to animate or snap.
   *
   * @param key         Unique per-unit key (`unit.id`) — not the row index and
   *                    not the source itemId, which is shared by every unit cut
   *                    from one ChatItem.
   * @param getIndex    Reactive function returning the current row index.
   * @param target      New logical reserved height.
   * @param shouldAnim  True iff this target change should be animated (vs snap).
   * @param owner       Optional identity of the claiming row; recorded so a
   *                    previous claimant's unregister cannot delete this entry.
   * @returns           Reactive handle for height/animating/clipHeight.
   */
  set(
    key: string,
    getIndex: () => number,
    target: number,
    shouldAnim: boolean,
    owner?: object
  ): TweenHandle;
  /**
   * Called by UnitRow's onCleanup (and when a row is handed a different unit) to
   * remove the entry. When `owner` is given the entry is only removed if it is
   * still the recorded claimant.
   */
  unregister(key: string, owner?: object): void;
  /**
   * Advance all active tweens by one frame. Call from the scheduler's animate
   * phase. Returns true while any entry is still mid-tween (keeps scheduler awake).
   */
  advance(now: number): boolean;
  /**
   * The current (animated) height of the row registered under `key`, or
   * undefined when no mounted row owns it. Untracked. Lets a virtualizer
   * re-seed keep the height a mounted row already reported (#6578).
   */
  heightOf(key: string): number | undefined;
};

// ── createTweenRegistry ───────────────────────────────────────────────────────

export type TweenRegistryOptions = {
  durationMs?: number;
  reducedMotion?: () => boolean;
  /**
   * Called when a new tween is armed so the frame scheduler wakes up.
   * In ChatRoot this calls `schedulerRef.request()`. Optional; falls back to a
   * standalone rAF (useful for tests that don't use the frame scheduler).
   */
  requestFrame?: () => void;
  /**
   * Clock function for recording tween start times. Defaults to
   * `performance.now()`. Override in tests for deterministic timing.
   */
  now?: () => number;
};

export function createTweenRegistry(
  virt: Virtualizer,
  onHeightChanged: (index: number, delta: number) => void,
  opts: TweenRegistryOptions = {}
): TweenRegistry {
  const {
    reducedMotion = defaultReducedMotion,
    requestFrame,
    now: nowFn = () => performance.now(),
  } = opts;

  const armScheduler =
    requestFrame ??
    (() => {
      // Fallback for environments without a frame scheduler (tests, stories).
      // A single rAF is enough; the registry will re-arm via advance() returning true.
      if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(() => {});
    });

  const entries = new Map<string, TweenEntry>();

  // Cache reduced-motion per-advance to avoid repeated matchMedia queries.
  let reducedMotionCache = reducedMotion();

  const set = (
    key: string,
    getIndex: () => number,
    target: number,
    shouldAnim: boolean,
    owner?: object
  ): TweenHandle => {
    const existing = entries.get(key);

    if (!existing) {
      // First registration: create the isolated owner + signals.
      let height!: Accessor<number>;
      let setHeight!: Setter<number>;
      let animating!: Accessor<boolean>;
      let setAnimating!: Setter<boolean>;
      let disposeOwner!: () => void;

      createRoot((dispose) => {
        disposeOwner = dispose;
        [height, setHeight] = createSignal(target);
        [animating, setAnimating] = createSignal(false);
      });

      const entry: TweenEntry = {
        from: target,
        to: target,
        startTime: 0,
        active: false,
        getIndex,
        height,
        setHeight,
        animating,
        setAnimating,
        disposeOwner,
        claimant: owner,
      };
      entries.set(key, entry);

      // Register the initial size in the virtualizer so its internal state
      // matches the row's known height from the start.
      const initialDelta = virt.setSize(getIndex(), target);
      if (initialDelta !== 0) onHeightChanged(getIndex(), initialDelta);

      return makeHandle(entry);
    }

    // Existing entry: update getIndex in case the row shifted due to prepend/re-flatten.
    existing.getIndex = getIndex;
    // Last claimant wins: a row taking over a key during a re-flatten owns it,
    // and the row that is leaving can no longer delete it out from under them.
    if (owner) existing.claimant = owner;

    if (target === existing.to) {
      // Target unchanged as a *logical* value — which is not the same as the
      // virtualizer already agreeing with it. A turn commit rebuilds the unit
      // list, and Virtualizer.setCount seeds a re-appearing index from the
      // coarse estimate(); measure() meanwhile returns the same height for the
      // same text whether the message streams or is committed, so the target
      // never changes and the old early return skipped setSize. The row then
      // painted its measured height into an estimate-sized slot and every row
      // below it sat too high — permanently, since prose lines are positioned
      // from engine geometry and nothing reads the DOM back. Reconcile the
      // stored size instead of assuming it. Mid-tween entries are left alone:
      // advance() owns the virtualizer for those frames.
      if (!existing.active) {
        // `target`, not `existing.height()`: on this path they are provably the
        // same value (the guard above excludes an armed tween, and every other
        // path lands height on `to`), and reading the signal here would make
        // UnitRow's calling effect track this row's height forever.
        const idx = getIndex();
        const delta = virt.setSize(idx, target);
        if (delta !== 0) onHeightChanged(idx, delta);
      }
      return makeHandle(existing);
    }

    // Target changed. Decide snap vs. animate.
    // Read the height UNTRACKED, for the same reason spelled out on the branch
    // above: set() is an imperative writer, and a plain read here would make
    // UnitRow's calling effect track this entry's height forever — an effect
    // that both reads and writes one signal. With a single owner per entry that
    // self-loop still settles in two rounds, but it is the amplifier that turned
    // a duplicated key into a renderer-killing recursion (#5332), so the writer
    // must not hand out subscriptions at all.
    const currentH = untrack(() => existing.height());
    const noMotion = reducedMotionCache || !shouldAnim;

    if (noMotion || currentH === target) {
      // Snap immediately.
      existing.from = target;
      existing.to = target;
      existing.active = false;
      existing.setHeight(target);
      existing.setAnimating(false);
      const delta = virt.setSize(getIndex(), target);
      if (delta !== 0) onHeightChanged(getIndex(), delta);
    } else {
      // Kick off a tween from the current animated height.
      // Capture startTime immediately so elapsed is correct on the first advance.
      existing.from = currentH;
      existing.to = target;
      existing.startTime = nowFn();
      existing.active = true;
      existing.setAnimating(true);
      // Arm the frame scheduler so advance() runs next frame.
      armScheduler();
    }

    return makeHandle(existing);
  };

  const unregister = (key: string, owner?: object) => {
    const entry = entries.get(key);
    if (entry && owner && entry.claimant && entry.claimant !== owner) return;
    if (entry) {
      entry.disposeOwner();
      entries.delete(key);
    }
  };

  const advance = (now: number): boolean => {
    // Refresh reduced-motion once per frame.
    reducedMotionCache = reducedMotion();

    const durationMs = collapseAnimationDefaults.durationMs;
    let anyActive = false;

    for (const [, entry] of entries) {
      if (!entry.active) continue;

      const elapsed = now - entry.startTime;
      const t = Math.min(1, elapsed / durationMs);
      const eased = easeOutCubic(t);
      const h = entry.from + (entry.to - entry.from) * eased;

      const idx = entry.getIndex();
      const delta = virt.setSize(idx, h);
      if (delta !== 0) onHeightChanged(idx, delta);

      entry.setHeight(h);

      if (t >= 1) {
        // Tween finished — land exactly on the target to eliminate float drift.
        entry.setHeight(entry.to);
        entry.active = false;
        entry.setAnimating(false);
      } else {
        anyActive = true;
      }
    }

    return anyActive;
  };

  const heightOf = (key: string): number | undefined => {
    const entry = entries.get(key);
    return entry ? untrack(entry.height) : undefined;
  };

  return { set, unregister, advance, heightOf };
}

// ── makeHandle — reactive accessor bundle for UnitRow ─────────────────────────

function makeHandle(entry: TweenEntry): TweenHandle {
  return {
    height: entry.height,
    animating: entry.animating,
    clipHeight: (gapBefore: number) => (entry.animating() ? entry.height() - gapBefore : null),
  };
}
