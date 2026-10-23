import type { TerminalState } from '@gugu/session-core/acp/client';
/**
 * ChatState — per-conversation, width-independent state.
 *
 * Holds the transcript (history + active turn), parse caches, and all
 * per-conversation view state that must survive view dispose/recreate
 * (e.g. tab switches):
 *
 *   viewState       — collapse map (inverted semantics: true = expanded)
 *   expandedUserId  — the single expanded user message card id
 *   scroll          — declarative scroll intent (ScrollMode: tail|anchor(edge))
 *   heightmap       — Map<unitId, measuredHeight> keyed by RenderUnit.id
 *                     (stable "${itemId}#self"). lastWidth is the container
 *                     width at snapshot time; used by ChatRoot to decide
 *                     whether seeded heights are pixel-accurate or estimates.
 *
 * Lives under a `createRoot` so it persists across ChatView mounts:
 * disposing a view does NOT dispose the state, so re-attaching a view
 * reuses Block object identities and warm WeakMap measurement caches.
 *
 * Lifetime: per conversation. Dispose when the conversation is closed.
 *
 * Usage:
 *   const state = createChatState(ctx);
 *   state.transcript.history.seed(items);
 *   const view = createChatView({ context: ctx, state, parent });
 *   // ... later, on conversation close:
 *   state.dispose();
 *
 * Note: scroll is per-viewport in semantics. If two views ever attached to
 * the same ChatState simultaneously they would contend for scroll. Today
 * there is exactly one view per conversation (ChatRoot is keyed by
 * conversationId in AcpChatPanel) — this assumption is intentional.
 */

import { createMemo, createRoot, createSignal } from 'solid-js';
import type { ChatContext } from '../chat-context';
import { createParseCaches } from '../core/caches';
import type { ParseCaches } from '../core/caches';
import type {
  AcpPermissionRequest,
  SessionPlans,
  SessionCondition,
  TranscriptTurn,
} from '../model';
import { createTranscript } from './transcript';
import type { TranscriptApi } from './transcript';
import { createViewState } from './view-state';
import type { ViewState } from './view-state';
export type { ScrollMode } from './scroll-mode';
export { tailMode, pinTopMode } from './scroll-mode';

// ScrollMode type and helpers live in scroll-mode.ts (re-exported above)
// so unit tests can import them without pulling in DOM-dependent parse caches.
import type { ScrollMode } from './scroll-mode';

/**
 * Per-conversation heightmap snapshot.
 *
 * Keys are stable `RenderUnit.id` values ("${itemId}#${key}", today always
 * "${itemId}#self" since every ChatItem maps to exactly one RenderUnit).
 * Values are measured row heights in pixels from the most recent view mount.
 *
 * `lastWidth` is the container width (px) when the snapshot was written.
 * ChatRoot uses it to decide whether to seed heights as pixel-accurate (same
 * width → no scrollbar drift) or as best-effort estimates (width changed →
 * anchor-based restore corrects position without drift).
 */
export type HeightmapStore = {
  /** Return the last-measured height for a unit id, or undefined on cache miss. */
  get(unitId: string): number | undefined;
  /** Bulk-write a set of unitId → height entries from a ChatRoot dispose snapshot. */
  setAll(entries: Iterable<[unitId: string, height: number]>): void;
  /** The container width when the most recent snapshot was taken. 0 = not set. */
  lastWidth: number;
};

export type ChatSessionState = {
  readonly state: ChatSessionSnapshot;
  setPermissions(permissions: readonly AcpPermissionRequest[]): void;
  setPlan(plan: SessionPlans | null): void;
  setPendingPrompt(prompt: PendingPrompt | null): void;
  setTerminals(terminals: readonly TerminalState[]): void;
  setGenerating(generating: boolean): void;
  /** 写这条会话此刻的状态；null = 没有条件要说。 */
  setCondition(condition: SessionCondition | null): void;
};

export type ChatSessionSnapshot = {
  readonly permissions: readonly AcpPermissionRequest[];
  readonly plan: SessionPlans | null;
  readonly pendingToolCallIds: Set<string>;
  readonly pendingPrompt: PendingPrompt | null;
  /**
   * 会话还在忙(#4981):在流式、agent 自发的 cycle 没收口、或还有后台子智能体在跑。
   * 与宿主上停止键亮不亮是**同一个**读数(runtime 的 `isGenerating`)。转录靠它判
   * 「跑完了没」—— 跑完之前没有哪一段算最终回复,也就没有哪一段该有复制按钮。
   */
  readonly generating: boolean;
  /**
   * 这条会话此刻的状态（引擎没装 / 要登录 / 连接断了 …），没有就是 null。
   * 由宿主写；转录把它画成列表末尾的一行。❌ 它不是历史，见 `SessionConditionItem` 抬头。
   */
  readonly condition: SessionCondition | null;
  terminalSnapshot(terminalId: string): TerminalState | null;
};

export type { PendingPrompt } from './pending-prompt';
import type { PendingPrompt } from './pending-prompt';

type LiveReadable<T> = {
  getSnapshot(): T | null | undefined;
  subscribe(listener: () => void): () => void;
};

export type ConnectSessionSource = {
  activeTurn: LiveReadable<TranscriptTurn | null>;
  plan: LiveReadable<SessionPlans | null>;
  sessionState: LiveReadable<{
    pendingPermissions: readonly AcpPermissionRequest[];
    /** runtime 投影出来的忙态(见 session-runtime machine `projectSessionState`)。 */
    isGenerating?: boolean;
  }>;
  terminals?: LiveReadable<readonly TerminalState[]>;
};

export type ConnectSessionOptions = {
  /**
   * 一轮讲完时调用。**必填**：一轮提交后 `activeTurn` 上保留着最后一帧（见 syncActiveTurn），
   * 而交还这一帧的唯一路径就是这个回调（调用方对完账后清）。设成可选就等于允许某个调用方
   * 让最后一轮永远压在已提交内容上面 —— 让编译器替这条约束把关。
   */
  onTurnCommitted: () => void;
};

export type ChatState = {
  /** Reactive transcript (history + active turn + turn status). */
  readonly transcript: TranscriptApi;
  /** Per-messageId parse caches. Stable Block identities enable WeakMap hits. */
  readonly parseCaches: ParseCaches;
  /**
   * Conversation URI passed to `createChatState`. Forwarded to
   * `MentionProvider.resolve` so a global provider can scope resolution to the
   * correct project or worktree.
   */
  readonly uri: string | undefined;

  // ── Per-conversation view state (persists across view remounts) ──────────

  /**
   * Collapse/expand state for collapsible rows.
   * Lives here (not in ChatRoot) so it survives tab switches.
   */
  readonly viewState: ViewState;

  /** Reactive session-level slices resolved by row renderers. */
  readonly session: ChatSessionState;

  /**
   * The id of the single currently-expanded user message card, or null.
   * Persisted here so re-mounting a view restores the expansion.
   */
  readonly expandedUserId: {
    get(): string | null;
    set(id: string | null): void;
  };

  /**
   * Declarative scroll intent. Written by ChatRoot's readPhase (user scroll)
   * and by the host via view.setScrollMode(); read by ChatRoot on mount/swap
   * to restore position without DOM geometry reads.
   */
  readonly scroll: {
    get(): ScrollMode;
    set(mode: ScrollMode): void;
  };

  /**
   * Measured row heights keyed by RenderUnit.id. Written by ChatRoot on
   * dispose; used to seed the Virtualizer on the next mount to avoid
   * scrollbar drift.
   */
  readonly heightmap: HeightmapStore;

  /**
   * Dispose the state's reactive root and all parse caches.
   * Call when the conversation is permanently closed (not just hidden).
   */
  dispose(): void;
};

export type ChatStateOptions = {
  /**
   * Conversation URI — passed as the second argument to
   * `MentionProvider.resolve(token, uri)` so the global provider can scope
   * resolution to the correct project or worktree.
   */
  uri?: string;
};

// ── createChatState ───────────────────────────────────────────────────────────

/**
 * Create a ChatState for a conversation.
 *
 * The state owns a `createRoot` so transcript signals, parse caches, and
 * per-conversation view state survive across view mounts/unmounts. Multiple
 * views can attach to the same state simultaneously (though only one view per
 * conversation is expected today — see scroll note above).
 *
 * @param ctx  - Shared ChatContext (provides highlighter, caches, theme).
 * @param opts - Optional per-conversation options (e.g. `uri`).
 */
export function createChatState(ctx: ChatContext, opts?: ChatStateOptions): ChatState {
  let transcript!: TranscriptApi;
  let parseCaches!: ParseCaches;
  let viewState!: ViewState;
  let session!: ChatSessionState;
  let getExpandedUserId!: () => string | null;
  let setExpandedUserId!: (id: string | null) => void;
  let disposeRoot!: () => void;

  createRoot((dispose) => {
    disposeRoot = dispose;
    transcript = createTranscript();
    parseCaches = createParseCaches(ctx.mentionProvider, ctx.commandProvider, opts?.uri);
    viewState = createViewState();
    [getExpandedUserId, setExpandedUserId] = createSignal<string | null>(null);
    session = createSessionState(transcript);
  });

  // Scroll mode — plain mutable value; not reactive (ChatRoot reads it once on
  // mount/swap, writes it via setAnchor in readPhase and host calls). No signal.
  let scrollMode: ScrollMode = { kind: 'tail' };

  // Heightmap — plain Map keyed by RenderUnit.id.
  const heightmapData = new Map<string, number>();
  let heightmapLastWidth = 0;

  const heightmap: HeightmapStore = {
    get(unitId) {
      return heightmapData.get(unitId);
    },
    setAll(entries) {
      for (const [id, h] of entries) {
        heightmapData.set(id, h);
      }
    },
    get lastWidth() {
      return heightmapLastWidth;
    },
    set lastWidth(w: number) {
      heightmapLastWidth = w;
    },
  };

  return {
    transcript,
    parseCaches,
    uri: opts?.uri,
    viewState,
    session,
    expandedUserId: {
      get: getExpandedUserId,
      set: setExpandedUserId,
    },
    scroll: {
      get: () => scrollMode,
      set: (mode) => {
        scrollMode = mode;
      },
    },
    heightmap,
    dispose() {
      parseCaches.clearAll();
      disposeRoot();
    },
  };
}

function createSessionState(transcript: TranscriptApi): ChatSessionState {
  const [permissions, setPermissions] = createSignal<readonly AcpPermissionRequest[]>([]);
  const [plan, setPlan] = createSignal<SessionPlans | null>(null);
  const [pendingPrompt, setPendingPrompt] = createSignal<PendingPrompt | null>(null);
  const [generating, setGenerating] = createSignal(false);
  const [condition, setCondition] = createSignal<SessionCondition | null>(null);
  const [terminals, setTerminals] = createSignal<ReadonlyMap<string, TerminalState>>(new Map());
  const recordedTerminals = createMemo(() => new Map(
    transcript.state.committedTurns.flatMap(turn => turn.terminals ?? []).map(terminal => [terminal.terminalId, terminal])
  ));
  const pendingToolCallIds = createMemo(() => {
    const ids = new Set<string>();
    for (const request of permissions()) {
      if (request.toolCall) ids.add(request.toolCall.toolCallId);
    }
    return ids;
  });

  const state: ChatSessionSnapshot = {
    get permissions() {
      return permissions();
    },
    get plan() {
      return plan();
    },
    get pendingToolCallIds() {
      return pendingToolCallIds();
    },
    get pendingPrompt() {
      return pendingPrompt();
    },
    get generating() {
      return generating();
    },
    get condition() {
      return condition();
    },
    terminalSnapshot(terminalId) {
      return terminals().get(terminalId) ?? recordedTerminals().get(terminalId) ?? null;
    },
  };

  return {
    state,
    setPermissions: (next) => setPermissions([...next]),
    setPlan,
    setPendingPrompt,
    setGenerating,
    setCondition,
    setTerminals: (next) => setTerminals(new Map(next.map(terminal => [terminal.terminalId, terminal]))),
  };
}

export function connectSession(
  state: ChatState,
  source: ConnectSessionSource,
  options: ConnectSessionOptions
): () => void {
  let hadActiveTurn = source.activeTurn.getSnapshot() !== null;

  const syncSessionState = (): void => {
    const snapshot = source.sessionState.getSnapshot();
    state.session.setPermissions(snapshot?.pendingPermissions ?? []);
    state.session.setGenerating(snapshot?.isGenerating ?? false);
  };

  const syncPlan = (): void => {
    state.session.setPlan(source.plan.getSnapshot() ?? null);
  };

  const syncActiveTurn = (): void => {
    const turn = source.activeTurn.getSnapshot() ?? null;
    if (turn) state.session.setPendingPrompt(null);
    if (!turn && hadActiveTurn) {
      // ❌ 别在这里就把刚讲完的那一轮抹掉。调用方收到这个回调后要去后端对账（实测一次往返 ~100ms），
      // 而已提交列表只由对账结果 seed 填充 —— 先抹掉就等于让画面整段空掉一百毫秒：transcript 消失、
      // 输入框退回空会话的占位文案再弹回来。用户看到的是「答完了反而闪一下」。
      // 保留最后这一帧，由对账落地时的 seed 覆盖它（失败也会清，见 acp-chat-store._refreshHistory）。
      options.onTurnCommitted();
    } else {
      state.transcript.activeTurn.set(turn);
    }
    hadActiveTurn = turn !== null;
  };
  const syncTerminals = (): void => {
    if (!source.terminals) return;
    state.session.setTerminals(source.terminals.getSnapshot() ?? []);
  };

  syncSessionState();
  syncPlan();
  syncActiveTurn();
  syncTerminals();

  const unsubs = [
    source.sessionState.subscribe(syncSessionState),
    source.plan.subscribe(syncPlan),
    source.activeTurn.subscribe(syncActiveTurn),
    ...(source.terminals ? [source.terminals.subscribe(syncTerminals)] : []),
  ];
  return () => {
    for (const unsub of unsubs) unsub();
  };
}
