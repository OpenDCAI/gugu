/**
 * AcpTranscriptParser — stateful wrapper around the pure composite reducer.
 *
 * A single push() call folds one raw ACP SessionUpdate into all slices:
 *   - transcript (committed turns + active turn)
 *   - config     (modelOptions / efforts / modeOptions / availableCommands)
 *   - usage      (contextUsed / contextSize / cost)
 *   - title      (session info title)
 *
 * Two usage modes:
 *
 *   Live streaming (push / endTurn):
 *     const parser = new AcpTranscriptParser({ conversationId, enrich });
 *     parser.push(sessionUpdate);
 *     parser.endTurn();             // called when prompt() resolves
 *     parser.history;               // committed turns
 *     parser.activeTurn;            // in-flight turn, or null
 *     parser.config;                // latest config state
 *     parser.usage;                 // latest usage, or null
 *     parser.title;                 // latest title, or null
 *
 *   Bounded replay (static):
 *     const result = AcpTranscriptParser.replay(updates, { conversationId, enrich });
 *     result.committed;             // finalized turns
 *     result.active;                // null after bounded replay
 *     result.config;                // SessionConfigState
 *     result.usage;                 // SessionUsage | null
 *     result.title;                 // string | null
 *
 * Provider enrichment:
 *   Pass an optional EnrichHook; raw updates are normalized at this facade before reduction.
 */

import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { AgentState } from '../models/agents';
import type { SessionConfigState, SessionUsage } from '../models/config';
import type { PlanState } from '../models/plan';
import type { TranscriptTurn, TranscriptTurnOutcome } from '../models/turns';
import type { EnrichHook, NormalizedEvent } from './normalized-event';
import { initialState, reduce, type ParserState } from './reducer';
import { decodeSessionUpdate } from '../transport/decode';

export interface AcpTranscriptParserDeps {
  sessionId: string;
  enrich?: EnrichHook;
}

export type ReplayResult = {
  committed: TranscriptTurn[];
  active: TranscriptTurn | null;
  config: SessionConfigState;
  usage: SessionUsage | null;
  title: string | null;
  agents: AgentState[];
  plan: PlanState | null;
};

export type ReplayEntry = SessionUpdate | { update: SessionUpdate; ts?: number; at?: number };

export class AcpTranscriptParser {
  private state: ParserState;
  private readonly deps: AcpTranscriptParserDeps;

  constructor(deps: AcpTranscriptParserDeps) {
    this.state = initialState();
    this.deps = { ...deps };
  }

  /**
   * Feed one raw ACP SessionUpdate into the parser.
   * Routes to the appropriate slice (transcript or config/usage/title).
   * For transcript-affecting variants, may open or close a turn.
   */
  push(update: SessionUpdate, at = Date.now()): void {
    this.state = reduce(this.state, {
      kind: 'event',
      event: this.deps.enrich
        ? this.deps.enrich(decodeSessionUpdate(update), update)
        : decodeSessionUpdate(update),
      at,
    }, this.deps);
  }

  pushEvent(event: NormalizedEvent, at = Date.now()): void {
    this.state = reduce(this.state, { kind: 'event', event, at }, this.deps);
  }

  /**
   * Explicitly close the active transcript turn.
   * Call this when prompt() resolves (stopReason is discarded — it belongs to
   * the session state machine, not the transcript).
   * No-op when there is no active turn.
   */
  endTurn(at = Date.now()): void {
    this.state = reduce(this.state, { kind: 'turn_end', at }, this.deps);
  }

  /** 已落定那一轮的迟到内容:折进最后一轮,❌ 不开新轮(见 `ReducerInput` 的 `tail`)。 */
  pushTail(event: NormalizedEvent, at = Date.now()): void {
    this.state = reduce(this.state, { kind: 'tail', event, at }, this.deps);
  }

  settleTurn(outcome: TranscriptTurnOutcome, at = Date.now()): void {
    this.state = reduce(this.state, { kind: 'turn_end', outcome, at }, this.deps);
  }

  /**
   * 用更外一层边界上的说法替掉**刚落定的那一轮**的结局 —— 理由与守卫写在
   * `ReducerInput` 的 `turn_outcome_superseded` 上。没有活跃轮、上一轮是 error 才生效。
   */
  supersedeLastTurnOutcome(outcome: TranscriptTurnOutcome, at = Date.now()): void {
    this.state = reduce(this.state, { kind: 'turn_outcome_superseded', outcome, at }, this.deps);
  }

  beginReplay(at = Date.now()): void {
    this.state = reduce(this.state, { kind: 'replay_start', at }, this.deps);
  }

  endReplay(at = Date.now(), outcome?: TranscriptTurnOutcome): void {
    this.state = reduce(this.state, { kind: 'replay_end', at, ...(outcome ? { outcome } : {}) }, this.deps);
  }

  /**
   * Reset all slices to their initial state.
   */
  reset(): void {
    this.state = initialState();
  }

  /**
   * 把整份内部状态原样交出去 / 收回来。
   *
   * 用途只有一个：让宿主把一条会话**已经折算好的**时间线存到磁盘上，下次开同一条会话时
   * 直接装回来、只读文件新长出来的那一段 —— 而不是把几十 MB 的记录从头重放一遍
   * （一份 18MB 的 claude 记录重放一次实测 1.7 秒，那是手机上「打开一条会话要等」的最大一项）。
   *
   * `ParserState` 是纯数据（没有 Map / Set / Date / 函数），所以直接 JSON 存取即可。
   * ⚠️ 它是**内部**结构，不是对外契约：换了形状要连着存档版本号一起升，
   * 版本对不上就整份重放 —— ❌ 不许把一份老结构硬塞进新 reducer。
   */
  snapshotState(): ParserState {
    return this.state;
  }

  restoreState(state: ParserState): void {
    this.state = state;
  }

  /** Attach the native receipt to the exact client-submitted message. */
  setRevertAnchor(messageId: string, anchor: string): void {
    const update = (turn: TranscriptTurn): TranscriptTurn => {
      let changed = false;
      const items = turn.items.map((item) => {
        if (item.kind !== 'message' || item.role !== 'user' || item.revertAnchor === anchor
          || !(item.id === messageId || item.id.endsWith(`:${messageId}`))) return item;
        changed = true;
        return { ...item, revertAnchor: anchor };
      });
      return changed ? { ...turn, items } : turn;
    };
    this.state = { ...this.state, transcript: {
      committed: this.state.transcript.committed.map(update),
      active: this.state.transcript.active ? update(this.state.transcript.active) : null,
    } };
  }

  /** Retain only the prefix before a provider-confirmed user message. */
  revertBefore(anchor: string): void {
    const index = this.history.findIndex((turn) => turn.items.some((item) =>
      item.kind === 'message' && item.revertAnchor === anchor));
    this.state = { ...this.state,
      transcript: { committed: index < 0 ? [] : this.history.slice(0, index), active: null },
      agents: [], plan: null, usage: null,
    };
  }

  /** All finalized, committed turns in chronological order. */
  get history(): readonly TranscriptTurn[] {
    return this.state.transcript.committed;
  }

  /** The in-flight turn, or null when the session is idle. */
  get activeTurn(): TranscriptTurn | null {
    return this.state.transcript.active;
  }

  /** Latest materialized session config (models / efforts / modes / commands). */
  get config(): SessionConfigState {
    return this.state.config;
  }

  /** Latest context-window usage, or null until the first usage_update arrives. */
  get usage(): SessionUsage | null {
    return this.state.usage;
  }

  /** Latest session title from session_info_update, or null. */
  get title(): string | null {
    return this.state.title;
  }

  get agents(): readonly AgentState[] {
    return this.state.agents;
  }

  get plan(): PlanState | null {
    return this.state.plan;
  }

  /**
   * Fold a finite iterable of SessionUpdates and return all four slices.
   *
   * The trailing active transcript turn (if any) is closed at EOF — there is
   * no stopReason available during replay. Config / usage / title are returned
   * as-of the last update seen.
   *
   * @param updates  An iterable of raw ACP SessionUpdate notifications.
   * @param deps     conversationId + optional EnrichHook.
   * @returns        { committed, active, config, usage, title }
   */
  static replay(updates: Iterable<ReplayEntry>, deps: AcpTranscriptParserDeps): ReplayResult {
    const parser = new AcpTranscriptParser(deps);
    let at = 0;

    parser.beginReplay(at);
    for (const entry of updates) {
      const update = 'sessionUpdate' in entry ? entry : entry.update;
      at = 'sessionUpdate' in entry ? at : (entry.at ?? entry.ts ?? at);
      parser.push(update, at);
      at += 1;
    }
    parser.endReplay(at);

    return {
      committed: [...parser.history],
      active: parser.activeTurn,
      config: parser.config,
      usage: parser.usage,
      title: parser.title,
      agents: [...parser.agents],
      plan: parser.plan,
    };
  }
}
