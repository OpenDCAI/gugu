import { findEntityOwner } from './entity-owner';
import { makeMessageId, makeThinkingId } from './ids';
/** Stateful projection of domain events. Protocol decoding belongs to transport/history ingress. */

import type { AgentState } from '../models/agents';
import type { SessionConfigState, SessionUsage } from '../models/config';
import type { SessionPlans } from '../models/plan';
import type { TranscriptTurn, TranscriptTurnOutcome } from '../models/turns';
import type { NormalizedEvent } from './normalized-event';
import { initialState, reduce, type ParserState } from './reducer';

export interface AcpTranscriptParserDeps {
  sessionId: string;
}

export type ReplayResult = {
  committed: TranscriptTurn[];
  active: TranscriptTurn | null;
  config: SessionConfigState;
  usage: SessionUsage | null;
  title: string | null;
  agents: AgentState[];
  plan: SessionPlans | null;
};

export type ReplayEntry = NormalizedEvent | { event: NormalizedEvent; ts?: number; at?: number };

export class AcpTranscriptParser {
  private state: ParserState;
  private readonly deps: AcpTranscriptParserDeps;

  constructor(deps: AcpTranscriptParserDeps) {
    this.state = initialState();
    this.deps = { ...deps };
  }

  pushEvent(event: NormalizedEvent, at = Date.now()): void {
    this.state = reduce(this.state, { kind: 'event', event, at }, this.deps);
  }

  /** Native rows can finish individual parts of the same assistant message. */
  pushRecordEvent(event: NormalizedEvent, at: number): void {
    const { committed, active } = this.state.transcript;
    const last = committed.at(-1);
    const messageId = event.kind === 'thinking' || (event.kind === 'message' && event.role === 'assistant')
      ? event.messageId : null;
    if (!active && last && messageId !== null && last.items.some(item =>
      item.id === makeMessageId(last.id, messageId, 'assistant') || item.id === makeThinkingId(last.id, messageId))) {
      // Preserve the turn/item identities; its next native boundary supplies the final outcome/time.
      this.state = { ...this.state, transcript: { committed: committed.slice(0, -1), active: last } };
    }
    this.pushEvent(event, at);
  }

  hasEntity(event: NormalizedEvent): boolean {
    return this.entityOwner(event) !== undefined;
  }

  entityOwner(event: NormalizedEvent): TranscriptTurn | undefined {
    return findEntityOwner(this.state.transcript, event);
  }

  /** Drop a local submitted row only after a receipt identifies its native echo. */
  removeSubmittedMessage(messageId: string): void {
    const update = (turn: TranscriptTurn): TranscriptTurn => {
      const items = turn.items.filter(item => item.kind !== 'message'
        || !(item.id === messageId || item.id.endsWith(`:${messageId}`)));
      return items.length === turn.items.length ? turn : { ...turn, items,
        initiator: items.some(item => item.kind === 'message' && item.role === 'user') ? 'user' : 'agent' };
    };
    this.state = { ...this.state, transcript: { committed: this.state.transcript.committed.map(update),
      active: this.state.transcript.active ? update(this.state.transcript.active) : null } };
  }

  /**
   * Explicitly close the active transcript turn.
   * The foreground owner supplies the boundary; a prompt receipt does not.
   * No-op when there is no active turn.
   */
  endTurn(at = Date.now()): void {
    this.state = reduce(this.state, { kind: 'turn_end', at }, this.deps);
  }

  /** 已落定那一轮的迟到内容:折进最后一轮,❌ 不开新轮(见 `ReducerInput` 的 `tail`)。 */
  pushTail(event: NormalizedEvent, at = Date.now()): void {
    this.state = reduce(this.state, { kind: 'tail', event, at }, this.deps);
  }

  settleTurn(outcome: TranscriptTurnOutcome, at = Date.now(), foreground?: TranscriptTurn['foreground']): void {
    this.state = reduce(this.state, { kind: 'turn_end', outcome, at, ...(foreground ? { foreground } : {}) }, this.deps);
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

  /** A cycle's native history boundary belongs to its inserted user messages. */
  setActiveRevertAnchor(anchor: string): void {
    const active = this.state.transcript.active;
    if (!active) return;
    const items = active.items.map(item => item.kind === 'message' && item.role === 'user'
      ? { ...item, revertAnchor: anchor } : item);
    this.state = { ...this.state, transcript: { ...this.state.transcript, active: { ...active, items } } };
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

  get plan(): SessionPlans | null {
    return this.state.plan;
  }

  /**
   * Fold a finite iterable of domain events and return all four slices.
   *
   * The trailing active transcript turn (if any) is closed at EOF — there is
   * no stopReason available during replay. Config / usage / title are returned
   * as-of the last update seen.
   *
   * @param updates  Domain deltas with optional source timestamps.
   * @param deps     The projection identity.
   * @returns        { committed, active, config, usage, title }
   */
  static replay(updates: Iterable<ReplayEntry>, deps: AcpTranscriptParserDeps): ReplayResult {
    const parser = new AcpTranscriptParser(deps);
    let at = 0;

    parser.beginReplay(at);
    for (const entry of updates) {
      const event = 'kind' in entry ? entry : entry.event;
      at = 'kind' in entry ? at : (entry.at ?? entry.ts ?? at);
      parser.pushEvent(event, at);
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
