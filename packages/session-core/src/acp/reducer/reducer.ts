/** Pure domain-event reducer for transcript, configuration and session entities. */

import type { AgentState, AgentStatus } from '../models/agents';
import type { SessionCommand, SessionConfigState, SessionUsage } from '../models/config';
import { initialSessionConfigState } from '../models/config';
import { SESSION_PLAN_ID, type SessionPlans } from '../models/plan';
import type {
  TranscriptItem,
  TranscriptThinking,
  ToolNode,
  TranscriptTurnInitiator,
  TranscriptTurnOutcome,
  TranscriptTurnTrigger,
  TranscriptTurn,
} from '../models/turns';
import { deriveConfigGroups } from './config-derive';
import { makeMessageId, makeThinkingId, makeTurnId } from './ids';
import { foldItem, finalizeItems, type FoldEvent } from './item-fold';
import { projectSubagentProgress } from './subagent-progress';
import type { NormalizedEvent } from './normalized-event';
import { findEntityOwner } from './entity-owner';
import { withReferencedTerminals } from '../models/terminals';

type SynthesizedSegmentKind = 'message:user' | 'message:assistant' | 'thinking';

export interface SegmentState {
  open: SynthesizedSegmentKind | null;
  user: number;
  assistant: number;
  thinking: number;
}

export interface TranscriptSlice {
  committed: TranscriptTurn[];
  active: TranscriptTurn | null;
}

export interface ParserState {
  transcript: TranscriptSlice;
  config: SessionConfigState;
  usage: SessionUsage | null;
  title: string | null;
  pendingModeId: string | null;
  segment: SegmentState;
  agents: AgentState[];
  plan: SessionPlans | null;
  /**
   * True between `replay_start` and `replay_end`.
   *
   * The reducer takes `at` from its caller and cannot tell a live clock from a
   * replay clock by looking at the number. This flag is the only place that
   * knows the difference, and `TranscriptTurn.startedAt` is the only consumer
   * of it: during replay the incoming `at` is *when we rebuilt the turn*, not
   * when it happened, so no timestamp is recorded at all.
   */
  replaying: boolean;
}

export type ReducerInput =
  | { kind: 'event'; event: NormalizedEvent; at: number }
  | { kind: 'replay_start'; at: number }
  | { kind: 'replay_end'; at: number; outcome?: TranscriptTurnOutcome }
  | { kind: 'turn_end'; at: number; outcome?: TranscriptTurnOutcome; foreground?: TranscriptTurn['foreground'] }
  /**
   * 回合已经落定之后才到的 agent 内容 —— 归**刚落定的那一轮**,作为它的尾巴。
   *
   * ACP 里 agent 的内容都属于某个 `session/prompt`;prompt 已经答复之后又来的那一条是那一轮的
   * 迟到部分(实例:copilot 取消后补来的「Info: Operation cancelled by user」,#6191)。
   * ⇒ 重开最后一条已提交的轮,折进去,再按原结局原样收回;它不开新轮。
   * 段计数随上一轮留着(见 `turn_end`),所以合成 id 不会撞上这一轮已有的消息;连续几段尾巴
   * 续在同一条消息上,❌ 不会被切成几行。一轮都还没有时,它自己成为一轮。
   */
  | { kind: 'tail'; event: NormalizedEvent; at: number }
  /**
   * 同一件事在**更外一层边界**上被重新认识了 —— 用后来的说法替掉刚落定的那一轮的结局。
   *
   * 唯一的产地是「适配器进程退出」:连接塌掉会先让在飞的 `session/prompt` 抛
   * `ACP connection closed`,我们据此把那一轮落成 `prompt_failed`;**毫秒之后**才收到进程的
   * exit,这才知道真相是「引擎死了,退出码 N」。两条读数说的是同一件事,后者严格更具体。
   * ⇒ 这不是"第二个写入者",是同一个分类器拿到更好的事实之后改口(#5858 / #4875 ②)。
   *
   * 守卫收得很紧:**有活跃轮就不做**(那一支走正常的 settle)、**上一轮不是 error 就不做**
   * (❌ 不许把一次成功的收尾改写成失败)。进程已经死了,不可能再有新的一轮开起来,
   * 所以"上一轮"就是被它终结的那一轮。
   */
  | { kind: 'turn_outcome_superseded'; at: number; outcome: TranscriptTurnOutcome };

export interface ReducerDeps {
  sessionId: string;
  newTurnReference?: () => string;
  /**
   * #980 回合序号从几开始数。接回会话不再让 agent 重放历史之后,运行时里一轮都没有,从 0 数出来的
   * `S:turn:0` 会和库里上一次运行留下的同名回合撞上(库按它认「这一轮落库没有」)。宿主按库里
   * 已有的最大序号 + 1 给出;缺席 = 0(重放会把序号顶上去,或者本来就是新会话)。
   */
  turnIndexBase?: number;
}

export function initialState(): ParserState {
  return {
    transcript: { committed: [], active: null },
    config: initialSessionConfigState,
    usage: null,
    title: null,
    pendingModeId: null,
    segment: initialSegment(),
    agents: [],
    plan: null,
    replaying: false,
  };
}

function initialSegment(): SegmentState {
  return {
    open: null,
    user: 0,
    assistant: 0,
    thinking: 0,
  };
}

function nextTurnIndex(t: TranscriptSlice, base = 0): number {
  return base + t.committed.length + (t.active ? 1 : 0);
}

function nextTurnSeq(t: TranscriptSlice): number {
  return t.committed.at(-1)?.seq !== undefined ? t.committed.at(-1)!.seq + 1 : 0;
}

/**
 * Open a new active turn.
 *
 * `startedAt` is the wall clock when the turn opened, or `undefined` when the
 * caller has no authentic clock to offer (replay). It is spread conditionally
 * so an unknown time is an ABSENT key rather than an explicit `undefined` —
 * the two are indistinguishable to a reader of the object but not to
 * serialization, and this field's whole contract is "absent = unknown".
 */
function openTurn(
  t: TranscriptSlice,
  deps: ReducerDeps,
  initiator: TranscriptTurnInitiator,
  startedAt: number | undefined,
  trigger?: TranscriptTurnTrigger
): TranscriptSlice {
  const id = makeTurnId(deps.sessionId, nextTurnIndex(t, deps.turnIndexBase));
  const turn: TranscriptTurn = {
    id,
    ...(deps.newTurnReference ? { referenceId: deps.newTurnReference() } : {}),
    seq: nextTurnSeq(t),
    initiator,
    ...(trigger ? { trigger } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    items: [],
  };
  return { ...t, active: turn };
}

/**
 * Finalize and commit the active turn to history.
 * No-op when there is no active turn.
 */
export function closeActive(
  t: TranscriptSlice,
  at: number,
  outcome?: TranscriptTurnOutcome,
  /** Wall clock to stamp as `endedAt`; undefined during replay (no truthful clock). */
  endedAt?: number
): TranscriptSlice {
  if (!t.active) return t;
  const committed: TranscriptTurn = {
    ...t.active,
    items: finalizeItems(t.active.items, at),
    ...(outcome !== undefined ? { outcome } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
  return { committed: [...t.committed, committed], active: null };
}

/**
 * Returns true when the incoming user message represents a NEW turn open.
 * Uses the CURRENT active turn's id — not a tentative next-turn id — so the
 * lookup matches the items already stored in the turn.
 */
export function isNewUserMessage(
  active: TranscriptTurn | null,
  event: Extract<NormalizedEvent, { kind: 'message' }>,
  segment: SegmentState
): boolean {
  if (!active) return true;
  if (event.messageId === null) {
    if (segment.open === 'message:user') return false;
    return active.items.some((it) => it.kind !== 'message' || it.role !== 'user');
  }
  const id = makeMessageId(active.id, event.messageId, 'user');
  return !active.items.some((it) => it.kind === 'message' && it.id === id);
}

function segmentStream(kind: SynthesizedSegmentKind): keyof Omit<SegmentState, 'open'> {
  switch (kind) {
    case 'message:user':
      return 'user';
    case 'message:assistant':
      return 'assistant';
    case 'thinking':
      return 'thinking';
  }
}

function segmentKind(
  event: Extract<NormalizedEvent, { kind: 'message' | 'thinking' }>
): SynthesizedSegmentKind {
  if (event.kind === 'thinking') return 'thinking';
  return event.role === 'user' ? 'message:user' : 'message:assistant';
}

function synthesizedMessageId(segment: SegmentState, kind: SynthesizedSegmentKind): string {
  const stream = segmentStream(kind);
  return `auto:${stream}:${segment[stream]}`;
}

function closeSynthesizedSegment(
  transcript: TranscriptSlice,
  segment: SegmentState,
  at: number
): { transcript: TranscriptSlice; segment: SegmentState } {
  const active = transcript.active;
  if (!active || !segment.open) return { transcript, segment };

  const openKind = segment.open;
  const stream = segmentStream(openKind);
  const messageId = synthesizedMessageId(segment, openKind);
  const itemId =
    openKind === 'thinking'
      ? makeThinkingId(active.id, messageId)
      : makeMessageId(active.id, messageId, stream);
  let changed = false;
  const items = active.items.map((item): TranscriptItem => {
    if (openKind === 'thinking') {
      if (item.kind === 'thinking' && item.id === itemId && item.status === 'thinking') {
        changed = true;
        return { ...item, status: 'done' as const, durationMs: at - item.startedAt };
      }
      return item;
    }
    return item;
  });

  const nextSegment: SegmentState = {
    ...segment,
    open: null,
    [stream]: segment[stream] + 1,
  };

  if (!changed) return { transcript, segment: nextSegment };
  return { transcript: { ...transcript, active: { ...active, items } }, segment: nextSegment };
}

function resolveProviderThinkingMessageId(active: TranscriptTurn, messageId: string): string {
  for (let i = active.items.length - 1; i >= 0; i -= 1) {
    const item = active.items[i];
    if (
      item.kind === 'thinking' &&
      item.status === 'thinking' &&
      (item.segmentId === messageId || item.segmentId.startsWith(`${messageId}:segment:`))
    ) {
      return item.segmentId;
    }
  }

  const baseId = makeThinkingId(active.id, messageId);
  const base = active.items.find(
    (item): item is TranscriptThinking => item.kind === 'thinking' && item.id === baseId
  );
  if (!base || base.status !== 'done') return messageId;

  const prefix = `${messageId}:segment:`;
  const count = active.items.filter(
    (item) => item.kind === 'thinking' && item.segmentId.startsWith(prefix)
  ).length;
  return `${prefix}${count + 1}`;
}

function materializeEvent(
  transcript: TranscriptSlice,
  segment: SegmentState,
  event: NormalizedEvent,
  at: number
): { transcript: TranscriptSlice; segment: SegmentState; event: FoldEvent } {
  if (event.kind === 'message' || event.kind === 'thinking') {
    if (event.messageId === null) {
      const kind = segmentKind(event);
      const closed =
        segment.open === kind
          ? { transcript, segment }
          : closeSynthesizedSegment(transcript, segment, at);
      const messageId = synthesizedMessageId(closed.segment, kind);
      const nextSegment = { ...closed.segment, open: kind };
      return {
        transcript: closed.transcript,
        segment: nextSegment,
        event: { ...event, messageId },
      };
    }

    const closed = closeSynthesizedSegment(transcript, segment, at);
    if (event.kind === 'thinking' && event.contentMode === undefined && closed.transcript.active) {
      return {
        ...closed,
        event: {
          ...event,
          messageId: resolveProviderThinkingMessageId(closed.transcript.active, event.messageId),
        },
      };
    }
    return { ...closed, event: event as FoldEvent };
  }

  // 「子智能体跑完了」是**外来的**通知,不是 agent 自己的段落结构:它随时可能落在一段
  // 正在流式的字中间。合成段(供应商不给 messageId 时按段计数造 id)若在这儿封口,
  // 下一段增量就拿到新号、另起一条消息 —— 同一句话被切成两行。⇒ 通知不碰段状态。
  if (event.kind === 'subagent_done') {
    return { transcript, segment, event: event as FoldEvent };
  }
  const closed = closeSynthesizedSegment(transcript, segment, at);
  return { ...closed, event: event as FoldEvent };
}

function toAgentStatus(
  status: Extract<NormalizedEvent, { kind: 'subagent' | 'subagent_done' }>['status']
): AgentStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'stopped';
    /**
     * 协议的 `disconnected` 就是我们早就有的 `lost`(失联) —— 见 `agentStatusSchema`
     * 上那段:既不是跑成也不是跑砸,是「我们和它断了,不知道它现在怎样」。
     * 两个词是同一件事的线上名与领域名,❌ 别再新造第三个态。
     */
    case 'disconnected':
      return 'lost';
    case 'pending':
    case 'in_progress':
    case null:
      return 'running';
  }
}

/**
 * 给「跑完了」这条事件补上它是谁的名字 —— 按派它出去的那次调用在登记册里查。
 *
 * ⚠️ 查的是 `toolCallId` 与 `agentId` 两条路:后台派发的通知带的是运行时 taskId,
 * 而登记册里那条是派发事件建的,两边只有一头能对上是常态。
 */
/**
 * 一条 task_notification 说的是哪次调用 —— 见 reduce() 里的注释。
 *
 * 返回:原事件(子智能体)/ 一条 `tool_update`(后台命令,归还给那张卡)/ null(对不上)。
 */
/**
 * 后台任务的原生 lane(`async_task_*`)→ 那张命令卡(#5117)。
 *
 * ⚠️ **`toolCallId` 缺席 = 还不知道,不是「没有父调用」**(协议原文:correlation becomes
 * known after spawn)。所以缺席时什么都不做,等后续 progress/state 带上它再落地 ——
 * ❌ 别为了「先显示出来」造一条顶层行,那正是 #5117 里那条凭空多出来的卡。
 */
/** 哪张卡挂着这个后台任务 id —— 纯从转录派生,❌ 不另记一份状态。 */
function findBackgroundTaskOwner(t: TranscriptSlice, asyncTaskId: string): string | null {
  const walk = (items: readonly unknown[]): string | null => {
    for (const raw of items) {
      const item = raw as ToolCallNodeLike & { backgroundTaskId?: string };
      if (item.backgroundTaskId === asyncTaskId && typeof item.toolCallId === 'string') {
        return item.toolCallId;
      }
      if (Array.isArray(item.children)) {
        const hit = walk(item.children);
        if (hit !== null) return hit;
      }
    }
    return null;
  };
  const inActive = t.active ? walk(t.active.items) : null;
  if (inActive !== null) return inActive;
  for (let i = t.committed.length - 1; i >= 0; i--) {
    const hit = walk(t.committed[i].items);
    if (hit !== null) return hit;
  }
  return null;
}

function resolveAsyncTask(
  event: Extract<NormalizedEvent, { kind: 'async_task' | 'async_task_progress' | 'async_task_state' }>,
  t: TranscriptSlice
): Extract<NormalizedEvent, { kind: 'tool_update' }> | null {
  // 归属:事件自带的优先;没带就看哪张卡已经挂着这个任务 id。
  //
  // 真机 2026-09-07 原始日志(`raw-e735816b.json`):`async_task_spawned` **不带** toolCallId,
  // 1ms 后的 `async_task_progress` 才带(协议注释「Originating tool call, when correlation
  // becomes known after spawn」说的就是这个);终态那条也带。只在 spawned 上取归属 ⇒ 卡永远
  // 挂不上任务 id ⇒ 摘要栏没有后台命令(owner 截图)。
  const toolCallId = event.toolCallId ?? findBackgroundTaskOwner(t, event.asyncTaskId);
  // 归属仍未知 = 还不知道;❌ 不造顶层行(这就是泄露)。
  if (!toolCallId) return null;

  if (event.kind === 'async_task' || event.kind === 'async_task_progress') {
    return {
      kind: 'tool_update',
      toolCallId,
      // 派发那次调用**在派发时就已经完成**了,「它还在后台跑」是另一件事。
      // ❌ 别把它改回 in_progress:那会让那次调用永远转圈。
      backgroundTaskId: event.asyncTaskId,
    };
  }

  // 只有终态才撤卡。`running`/`paused` 是它还活着 —— 尤其 `paused`,❌ 别当成结束。
  if (event.state !== 'completed' && event.state !== 'failed' && event.state !== 'stopped') {
    return null;
  }
  return {
    kind: 'tool_update',
    toolCallId,
    // 被叫停 = 没跑完,按失败落定,原因在 outputText 里(与 resolveTaskNotification 同一约定)。
    status: event.state === 'stopped' ? 'failed' : event.state,
    backgroundTaskDone: true,
    ...(event.summary !== undefined ? { outputText: event.summary } : {}),
  };
}

/** Join native launch-result identities to registered child entities; never infer from prose. */
function canonicalizeSubagentIdentity(
  event: NormalizedEvent,
  agents: readonly AgentState[]
): NormalizedEvent {
  if (event.kind === 'subagent' && !event.subagentSessionId && event.agentId) {
    const owner = agents.find((agent) => agent.subagentSessionId === event.agentId);
    if (owner && owner.toolCallId !== event.toolCallId) {
      return { ...event, toolCallId: owner.toolCallId, agentToolUseId: event.toolCallId };
    }
  }
  if ('parentToolCallId' in event && typeof event.parentToolCallId === 'string') {
    const parent = event.parentToolCallId;
    const owner = agents.find((agent) => agent.agentToolUseId === parent);
    if (owner && owner.toolCallId !== parent) {
      return { ...event, parentToolCallId: owner.toolCallId } as NormalizedEvent;
    }
  }
  return event;
}

/** Route each child's output and tools to its original launch, even after the parent moves to another turn.
 * Unregistered children never acquire a top-level transcript row.
 */
function reduceSubagentStream(
  s: ParserState,
  stream: Extract<NormalizedEvent, { kind: 'subagent_stream' }>,
  at: number,
  deps: ReducerDeps
): ParserState {
  const owner = s.agents.find((agent) => agent.subagentSessionId === stream.subagentSessionId);
  if (!owner) return s;
  const inner = stream.event;
  const active = s.transcript.active;
  const launch = active && findToolCallNode(active.items, owner.toolCallId) ? active
    : s.transcript.committed.find((turn) => findToolCallNode(turn.items, owner.toolCallId));

  if (inner.kind === 'agent_state') {
    const ids = { toolCallId: owner.toolCallId, agentId: owner.agentId, subagentSessionId: stream.subagentSessionId };
    const event: NormalizedEvent = inner.state === 'running' || inner.state === 'requires_action'
      ? { kind: 'subagent_update', ...ids, status: 'in_progress' }
      : { kind: 'subagent_done', ...ids,
          status: inner.state === 'unknown' ? 'disconnected' : inner.state === 'idle' && inner.stopReason === 'cancelled' ? 'stopped'
            : inner.state === 'idle' && inner.stopReason === 'error' ? 'failed' : 'completed',
          ...(inner.state === 'idle' && inner.summary !== undefined ? { summary: inner.summary } : {}) };
    return reduce(s, { kind: 'event', event, at }, deps);
  }
  if (inner.kind === 'config') {
    const model = inner.options.find(option => option.category === 'model')?.currentValue;
    return typeof model === 'string' ? { ...s,
      agents: s.agents.map(agent => agent === owner ? { ...agent, model } : agent) } : s;
  }
  if (inner.kind === 'message' && inner.role === 'user') {
    if (!launch) return s;
    const previous = findToolCallNode(launch.items, owner.toolCallId);
    const rawInput = inner.contentMode === 'append' ? (previous && 'rawInput' in previous && typeof previous.rawInput === 'string' ? previous.rawInput : '') + inner.text : inner.text;
    const items = foldItem(launch.items, { kind: 'subagent', toolCallId: owner.toolCallId,
      status: null, parentToolCallId: null, rawInput }, launch.id, at, s.replaying ? undefined : at);
    const updated = { ...launch, items };
    return { ...s, transcript: { active: launch === active ? updated : active,
      committed: launch === active ? s.transcript.committed : s.transcript.committed.map(turn => turn === launch ? updated : turn) } };
  }
  if (inner.kind === 'message' || inner.kind === 'thinking') {
    if (inner.kind === 'message' && inner.role !== 'assistant') return s;
    const field = inner.kind === 'thinking' ? 'reasoning' : 'output';
    const value = (owner[field] ?? '') + inner.text;
    return { ...s, agents: s.agents.map((agent) => agent === owner ? { ...agent, [field]: value } : agent) };
  }

  switch (inner.kind) {
    case 'tool_call':
    case 'tool_update':
    case 'subagent':
    case 'search':
    case 'mcp_tool':
    case 'web_fetch': {
      if (!launch) return s;
      // 父节点**一律**是派它那张卡,❌ 不看事件自带的 `parentToolCallId`:它带的是 Agent 那次调用的
      // tool_use id,而那个别名要等 Agent 的 tool_call_update 到了才登记 —— 同步派发时那条更新
      // 在子智能体**跑完**才来,中途的子调用父节点查不到,就掉成顶层(owner 2026-09-07 截图:
      // 子智能体的 7 次读文件成了主对话里的一组「7 file reads」)。事件既然是按子会话号认出来的,
      // 它属于谁已经知道了,没有第二种答案。
      const nested = { ...inner, parentToolCallId: owner.toolCallId };
      const items = foldItem(launch.items, nested, launch.id, at, s.replaying ? undefined : at);
      const updated = { ...launch, items };
      const agents = updateAgentSlice(s.agents, nested, launch.id, at).map((agent) => agent.agentId === owner.agentId
        ? { ...agent, activityVersion: (agent.activityVersion ?? 0) + 1 } : agent);
      return { ...s, agents, transcript: {
        active: launch === active ? updated : active,
        committed: launch === active ? s.transcript.committed : s.transcript.committed.map((turn) => turn === launch ? updated : turn),
      } };
    }
    case 'subagent_stream': return reduce(s, { kind: 'event', event: inner, at }, deps);
    default:
      return s;
  }
}

function resolveTaskNotification(
  event: Extract<NormalizedEvent, { kind: 'subagent_done' }>,
  agents: readonly AgentState[],
  t: TranscriptSlice
): Extract<NormalizedEvent, { kind: 'subagent_done' | 'tool_update' }> | null {
  const known = agents.find(
    (agent) => agent.toolCallId === event.toolCallId || agent.agentId === event.agentId
  );
  // 对上了登记册 ⇒ 把 id 归一到派发那次调用。同一个任务会来不止一条通知,后来的那条可能只带
  // taskId(2026-09-06 引擎日志实测):不归一的话两条各自成行,一个子智能体出两行「已完成」。
  if (known) return { ...event, toolCallId: known.toolCallId, agentId: known.agentId };
  const call =
    findToolCallNode(t.active?.items ?? [], event.toolCallId) ??
    findToolCallNodeInTurns(t.committed, event.toolCallId);
  if (call === null) return null;
  if (call.kind === 'spawn-subagent-tool-call') return event;
  return {
    kind: 'tool_update',
    toolCallId: event.toolCallId,
    // 后台命令被叫停(stop_task → stopped):它没跑完,那张命令卡按失败落定,原因在 outputText 里。
    //
    // 失联(disconnected)则**不写状态**:ACP 的工具状态只有 pending/in_progress/completed/
    // failed 四个,失联一个都不是。这里字段缺席表示「保持不变」⇒ 如实表达「不知道」。
    // ❌ 别顺手写成 failed —— 那是把「不知道」断言成「知道它砸了」。
    status:
      event.status === 'stopped' ? 'failed' : event.status === 'disconnected' ? undefined : event.status,
    ...(call.parentToolCallId !== undefined ? { parentToolCallId: call.parentToolCallId } : {}),
    // 它不再在跑 —— 面板上那张「后台命令」卡据此撤下(#5117)。
    backgroundTaskDone: true,
    ...(event.summary !== undefined ? { outputText: event.summary } : {}),
  };
}

type ToolCallNodeLike = {
  kind: string;
  toolCallId?: string;
  parentToolCallId?: string | null;
  children?: readonly unknown[];
};

/**
 * 把一条后台任务更新就地写到**已落定轮**里的那张卡上;找不到返回 null(调用方照旧走 fold)。
 * 只改这几格:状态、输出、后台任务 id / 落定标记 —— 不动 seq/id/位置,历史的形状不变。
 */
function patchToolCallInTurns(
  turns: readonly TranscriptTurn[],
  event: Extract<NormalizedEvent, { kind: 'tool_update' }>
): TranscriptTurn[] | null {
  const status =
    event.status === 'completed'
      ? 'done'
      : event.status === 'failed'
        ? 'error'
        : event.status === 'in_progress' || event.status === 'pending'
          ? 'running'
          : undefined;
  const patch = {
    ...(status !== undefined ? { status } : {}),
    ...(event.outputText !== undefined ? { outputText: event.outputText } : {}),
    ...(event.backgroundTaskId !== undefined ? { backgroundTaskId: event.backgroundTaskId } : {}),
    ...(event.backgroundTaskDone !== undefined ? { backgroundTaskDone: event.backgroundTaskDone } : {}),
  };
  let hit = false;
  const mapItems = <T>(items: readonly T[]): T[] => {
    let changed = false;
    const next = items.map((raw) => {
      const item = raw as T & ToolCallNodeLike;
      if (item.toolCallId === event.toolCallId && item.kind !== 'subagent-done-tool-call') {
        hit = true;
        changed = true;
        return { ...item, ...patch } as T;
      }
      if (Array.isArray(item.children)) {
        const children = mapItems(item.children);
        if (children !== item.children) {
          changed = true;
          return { ...item, children } as T;
        }
      }
      return raw;
    });
    return changed ? next : (items as T[]);
  };
  const next = turns.map((turn) => {
    const items = mapItems(turn.items);
    return items === turn.items ? turn : { ...turn, items };
  });
  return hit ? next : null;
}

function findToolCallNodeInTurns(
  turns: readonly TranscriptTurn[],
  toolCallId: string
): ToolCallNodeLike | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const hit = findToolCallNode(turns[i].items, toolCallId);
    if (hit !== null) return hit;
  }
  return null;
}

/** 顺着 `children`(子智能体的子调用、tool-group 的成员)一路找下去。 */
function findToolCallNode(items: readonly unknown[], toolCallId: string): ToolCallNodeLike | null {
  for (const raw of items) {
    const item = raw as ToolCallNodeLike;
    if (item.toolCallId === toolCallId && item.kind !== 'subagent-done-tool-call') return item;
    if (Array.isArray(item.children)) {
      const hit = findToolCallNode(item.children, toolCallId);
      if (hit !== null) return hit;
    }
  }
  return null;
}

function withAgentName(
  event: Extract<NormalizedEvent, { kind: 'subagent_done' }>,
  agents: readonly AgentState[]
): Extract<NormalizedEvent, { kind: 'subagent_done' }> {
  const hit = agents.find(
    (agent) => agent.toolCallId === event.toolCallId || agent.agentId === event.agentId
  );
  if (!hit) return event;
  return {
    ...event,
    ...(hit.name ? { name: hit.name } : {}),
    // 它回给主智能体的正文来自子会话流(登记册 `output`,#5117);完成通知本身不带正文。
    // 登记册不随轮走,所以子智能体活过了派它那一轮,正文照样能落到「跑完了」这一行上。
    ...(event.outputText === undefined && hit.output ? { outputText: hit.output } : {}),
  };
}

function updateAgentSlice(
  agents: AgentState[],
  event: NormalizedEvent,
  launchTurnId: string | null,
  at: number
): AgentState[] {
  // 「它跑完了」现在是转录里的又一次工具调用(见 claude/acp-transform.ts),登记册照样要跟上 ——
  // 会话忙不忙那一路读的是登记册,不是转录。
  const notified = event.kind === 'subagent_done' ? event : undefined;
  if (notified === undefined && event.kind !== 'subagent' && event.kind !== 'subagent_update') {
    return agents;
  }

  let agentId = notified?.agentId ?? ('agentId' in event ? event.agentId : undefined) ?? ('toolCallId' in event ? event.toolCallId : undefined);
  if (!agentId) return agents;

  const toolCallId = notified?.toolCallId ?? ('toolCallId' in event ? event.toolCallId : undefined) ?? agentId;
  const idx = agents.findIndex(
    (agent) => agent.agentId === agentId || agent.toolCallId === toolCallId
  );
  if (!('agentId' in event) && idx >= 0) agentId = agents[idx].agentId;
  const status = toAgentStatus(notified?.status ?? ('status' in event ? (event.status ?? null) : null));
  const completedAt =
    status === 'completed' || status === 'failed' || status === 'stopped'
      ? { completedAt: at }
      : idx >= 0
        ? agents[idx].completedAt !== undefined
          ? { completedAt: agents[idx].completedAt }
          : {}
        : {};

  if (event.kind === 'subagent') {
    // ⚠️ 登记册记的是**那个智能体**跑没跑完,不是**那次派发调用**完没完成 —— 后台派发里
    // 这是两件事:启动返回了(调用完成),而它才刚开始干活。
    //
    // owner 2026-09-06 定的模型下,转录那一行在启动返回时就完成了,所以这里**不能**
    // 再拿那一行的状态当智能体的状态,否则登记册会在派出去的同一刻就宣布它跑完了,
    // 面板上一张卡都留不住。⇒ 后台派发一律先记成 running,等真信号(完成通知 /
    // SessionOutput 收割)把它推到 completed/failed。
    // 同步的那种没有这个分裂:调用完成就是它干完了。
    const launchStatus = (event.background ?? (idx >= 0 ? agents[idx].background : false)) === true ? 'running' : status;
    const launchCompletedAt = launchStatus === 'running' ? {} : completedAt;
    const next: AgentState = {
      ...(idx >= 0 ? agents[idx] : {}),
      agentId,
      toolCallId,
      launchTurnId,
      // 「缺席 = 保持不变」,与条目那边同一个约定(见 item-fold 的 subagent 分支)。
      // 供应商的末条事件不带 title,写进来会把先前那个真名字盖掉。
      // 从来没有过名字时退回**派活那句话**(codex 就只给这个),再退回 agentId ——
      // 那是个 `call_xxx` 之类的原始 id,摆在侧栏上没人读得懂,只当最后一道。❌ 不编。
      name: event.title ?? (idx >= 0 ? agents[idx].name : (event.inputSummary ?? agentId)),
      // 已经收到过完成通知的,❌ 别被后到的派发事件推回 running(同一次派发会来好几条)。
      status: idx >= 0 && agents[idx].status !== 'running' ? agents[idx].status : launchStatus,
      startedAt: idx >= 0 ? agents[idx].startedAt : at,
      ...(event.background !== undefined ? { background: event.background } : {}),
      ...(event.canCancel !== undefined ? { canCancel: event.canCancel } : {}),
      ...(event.model !== undefined ? { model: event.model } : {}),
      ...(event.outputFile !== undefined ? { outputFile: event.outputFile } : {}),
      // 身份两格只增不改:会话号来自 `subagent_spawned`,别名来自 Agent 那次调用(见
      // `canonicalizeSubagentIdentity`)。
      ...(event.subagentSessionId !== undefined ? { subagentSessionId: event.subagentSessionId } : {}),
      ...(event.agentToolUseId !== undefined ? { agentToolUseId: event.agentToolUseId } : {}),
      ...(idx >= 0 && agents[idx].completedAt !== undefined
        ? { completedAt: agents[idx].completedAt }
        : launchCompletedAt),
    };
    return idx >= 0 ? agents.map((agent, i) => (i === idx ? next : agent)) : [...agents, next];
  }

  const summary = notified?.summary ?? ('summary' in event ? event.summary : undefined);
  const outputFile = notified?.outputFile ?? ('outputFile' in event ? event.outputFile : undefined);
  const restarted = event.kind === 'subagent_update' && status === 'running' && idx >= 0 && agents[idx].status !== 'running';
  const next: AgentState = {
    ...(idx >= 0
      ? agents[idx]
      : {
          agentId,
          toolCallId,
          launchTurnId,
          name: agentId,
          startedAt: at,
        }),
    agentId,
    toolCallId,
    status,
    ...(summary !== undefined ? { summary } : {}),
    ...(outputFile !== undefined ? { outputFile } : {}),
    ...completedAt,
    ...(event.kind === 'subagent_update' && event.canCancel !== undefined ? { canCancel: event.canCancel } : {}),
    ...(status !== 'running' ? { canCancel: false } : {}),
    ...(restarted ? { startedAt: at, completedAt: undefined, output: undefined, reasoning: undefined } : {}),
  };
  return idx >= 0 ? agents.map((agent, i) => (i === idx ? next : agent)) : [...agents, next];
}

function updatePlanSlice(
  plans: SessionPlans | null,
  event: NormalizedEvent,
  at: number
): SessionPlans | null {
  if (event.kind === 'plan_remove') {
    if (!plans || !(event.planId in plans)) return plans;
    const next = { ...plans };
    delete next[event.planId];
    return Object.keys(next).length ? next : null;
  }
  if (event.kind !== 'plan') return plans;
  const id = event.planId ?? SESSION_PLAN_ID;
  return { ...plans, [id]: {
    id, entries: event.entries.map((entry, index) => ({ id: `${id}:entry:${index}`, ...entry })),
    ...(event.body !== undefined ? { body: event.body } : {}),
    ...(event._meta !== undefined ? { _meta: event._meta } : {}), updatedAt: at,
  } };
}

function assertTurnInvariants(turn: TranscriptTurn): void {
  const ids = new Set<string>();
  const assertSortedSiblings = (items: TranscriptItem[] | ToolNode[]): void => {
    let previousSeq = -1;
    const siblingSeqs = new Set<number>();
    for (const item of items) {
      if (item.seq < previousSeq) {
        throw new Error(
          'AcpTranscriptParser invariant failed: sibling items are not sorted by seq'
        );
      }
      previousSeq = item.seq;
      if (siblingSeqs.has(item.seq)) {
        throw new Error(
          `AcpTranscriptParser invariant failed: duplicate sibling seq '${item.seq}'`
        );
      }
      siblingSeqs.add(item.seq);
    }
  };
  const visit = (item: TranscriptItem | ToolNode): void => {
    if (ids.has(item.id)) {
      throw new Error(`AcpTranscriptParser invariant failed: duplicate item id '${item.id}'`);
    }
    ids.add(item.id);
    if ('children' in item && item.children?.length) {
      assertSortedSiblings(item.children);
      for (const child of item.children) visit(child);
    }
  };

  let openThinking = 0;
  assertSortedSiblings(turn.items);
  for (const item of turn.items) {
    visit(item);
    if (item.kind === 'thinking' && item.status === 'thinking') openThinking += 1;
  }
  if (openThinking > 1) {
    throw new Error('AcpTranscriptParser invariant failed: multiple open thinking rows');
  }
}

/**
 * 查过的轮 / 查过的历史数组，按**对象身份**记。
 *
 * 这道校验本意是开发期的安全网，但它的开关 `NODE_ENV === 'production'` 在 Electron 主进程里
 * 从来不成立 —— 打包后没人设这个变量（构建产物里它是活的运行时查表，不是被内联成常量）。
 * 于是它在线上照跑，而它是**平方级**的：每折进一条条目就把整条会话从头到尾重走一遍。
 * 实测（一轮 = 1 问 + 3 段回答 + 2 个工具调用）：2000 轮的会话打开一次 9421ms，
 * 把守卫短路掉是 153ms，62 倍，且倍数随会话变长继续涨 —— 这就是「越长越卡」。
 *
 * 修法不是把守卫关严：那是拿一张真发现过 bug 的安全网去换速度，而且开发期同样卡。
 * 轮和历史数组都是不可变的（reducer 只在内容真变了时才造新对象），所以查过一次的**那个对象**
 * 永远合规，再查纯属浪费。校验强度一点没降，成本从「每步查全量」变成「每步只查这一步真换掉的
 * 那几个对象」。WeakSet 不拦回收，换代丢掉的轮该走就走。
 */
const checkedTurns = new WeakSet<TranscriptTurn>();
const checkedHistories = new WeakSet<TranscriptTurn[]>();

function assertTurnInvariantsOnce(turn: TranscriptTurn): void {
  if (checkedTurns.has(turn)) return;
  assertTurnInvariants(turn);
  checkedTurns.add(turn);
}

function assertTranscriptInvariants(transcript: TranscriptSlice): void {
  if (process.env.NODE_ENV === 'production') return;
  const { committed, active } = transcript;
  // 历史整段只在它真被换过时查:committed 是追加或整体替换出来的,数组身份没变就说明
  // 每一轮都还是上一次查过的那一批。折条目的那条路径原样带走这个数组,所以直播中它一直命中。
  if (!checkedHistories.has(committed)) {
    let previousTurnSeq = -1;
    for (const turn of committed) {
      if (turn.seq <= previousTurnSeq) {
        throw new Error(
          'AcpTranscriptParser invariant failed: committed turns are not sorted by seq'
        );
      }
      previousTurnSeq = turn.seq;
      assertTurnInvariantsOnce(turn);
    }
    checkedHistories.add(committed);
  }
  if (active) {
    // 排序已经查过，最后一轮的 seq 就是历史的上界，不用再走一遍。
    const lastCommittedSeq = committed.at(-1)?.seq ?? -1;
    if (active.seq <= lastCommittedSeq) {
      throw new Error('AcpTranscriptParser invariant failed: active turn seq is not after history');
    }
    assertTurnInvariantsOnce(active);
  }
}

/**
 * Pure reducer: (ParserState, ReducerInput, ReducerDeps) → ParserState.
 * All state changes return a new ParserState; no mutation occurs.
 */
export function reduce(s: ParserState, input: ReducerInput, deps: ReducerDeps): ParserState {
  return projectSubagentProgress(reduceState(s, input, deps));
}

function reduceState(s: ParserState, input: ReducerInput, deps: ReducerDeps): ParserState {
  if (input.kind === 'replay_start') {
    return { ...initialState(), replaying: true };
  }

  if (input.kind === 'replay_end') {
    const transcript = closeActive(s.transcript, input.at, input.outcome);
    // 重放里派出去、到这儿还没等到完成通知的后台子智能体:它们跑在**上一个**进程里,
    // resume 不会把它们带过来,也没有接口能去问 —— 见 agents.ts `lost`。
    // ❌ 不判 completed / failed:我们不知道,也不装知道。
    const agents = s.agents.map((agent) =>
      agent.status === 'running' && agent.background === true
        ? { ...agent, status: 'lost' as const }
        : agent
    );
    // 与 `turn_end` 同理:段计数留给最后那一轮的尾巴(`tail`),否则尾巴的合成 id 撞上它已有的消息。
    const segment = closeSynthesizedSegment(s.transcript, s.segment, input.at).segment;
    return { ...s, transcript, agents, segment, replaying: false };
  }

  if (input.kind === 'turn_outcome_superseded') {
    const { committed, active } = s.transcript;
    const last = committed.at(-1);
    if (active || !last || last.outcome?.kind !== 'error') return s;
    const rest = committed.slice(0, -1);
    return {
      ...s,
      transcript: { ...s.transcript, committed: [...rest, { ...last, outcome: input.outcome }] },
    };
  }

  if (input.kind === 'turn_end') {
    let transcript = closeActive(
      s.transcript,
      input.at,
      input.outcome,
      s.replaying ? undefined : input.at
    );
    if (input.foreground && transcript !== s.transcript) {
      transcript = { ...transcript, committed: transcript.committed.map((turn, index) =>
        index === transcript.committed.length - 1 ? { ...turn, foreground: input.foreground } : turn) };
    }
    // 段计数**留给这一轮的尾巴**(`tail`):收口只封住当前开着的段,下一条尾巴拿新号。
    // 新一轮开起来时(用户消息 / 懒开)才从零数。
    const segment = closeSynthesizedSegment(s.transcript, s.segment, input.at).segment;
    return transcript === s.transcript ? { ...s, segment } : { ...s, transcript, segment };
  }

  if (input.kind === 'tail') {
    const { committed, active } = s.transcript;
    const last = committed.at(-1);
    const event: ReducerInput = { kind: 'event', event: input.event, at: input.at };
    if (active) return reduce(s, event, deps);
    const reopened: ParserState = last
      ? { ...s, transcript: { committed: committed.slice(0, -1), active: last } }
      : s;
    const folded = reduce(reopened, event, deps);
    // 重开的那一轮带着自己的 outcome / endedAt,`closeActive` 原样保留;新成的一轮以此刻为终点。
    const transcript = closeActive(
      folded.transcript,
      input.at,
      undefined,
      last || s.replaying ? undefined : input.at
    );
    return { ...folded, transcript };
  }

  const event = canonicalizeSubagentIdentity(input.event, s.agents);

  if (event.kind === 'subagent_done' && event.subagentSessionId) {
    const previous = s.agents.find((agent) => agent.subagentSessionId === event.subagentSessionId);
    if (previous?.status === toAgentStatus(event.status) && (!event.summary || previous.summary === event.summary)) return s;
  }

  if (event.kind === 'subagent_stream') return reduceSubagentStream(s, event, input.at, deps);

  const owner = findEntityOwner(s.transcript, event);
  if (owner && owner !== s.transcript.active) {
    const items = foldItem(owner.items, event as FoldEvent, owner.id, input.at);
    return { ...s, plan: updatePlanSlice(s.plan, event, input.at), transcript: { ...s.transcript, committed: s.transcript.committed.map(turn => turn === owner ? { ...owner, items } : turn) } };
  }

  if (event.kind === 'plan_remove') {
    const remove = (turn: TranscriptTurn): TranscriptTurn => {
      const items = turn.items.filter(item => item.kind !== 'create-plan-tool-call' || item.planId !== event.planId);
      return items.length === turn.items.length ? turn : { ...turn, items };
    };
    return { ...s, plan: updatePlanSlice(s.plan, event, input.at), transcript: {
      committed: s.transcript.committed.map(remove),
      active: s.transcript.active ? remove(s.transcript.active) : null,
    } };
  }

  switch (event.kind) {
    case 'config': {
      const groups = deriveConfigGroups(event.options);
      const config: SessionConfigState = { ...s.config, ...groups };
      if (s.pendingModeId && config.modeOptions) {
        config.modeOptions = { ...config.modeOptions, selected: s.pendingModeId };
      }
      return {
        ...s,
        config,
        pendingModeId: config.modeOptions ? null : s.pendingModeId,
      };
    }
    case 'mode_selected': {
      if (!s.config.modeOptions) return { ...s, pendingModeId: event.modeId };
      const config: SessionConfigState = {
        ...s.config,
        modeOptions: { ...s.config.modeOptions, selected: event.modeId },
      };
      return { ...s, config, pendingModeId: null };
    }
    case 'modes_state': {
      // 让位规则:`config` 事件给出的 mode 组带真 configId(unstable set_config_option 通道),
      // 稳定版 modes 只补空位 —— 两者都在时,信息更全的那组不许被覆盖。
      if (s.config.modeOptions?.configId) return s;
      if (event.availableModes.length === 0) return s;
      const selected = s.pendingModeId ?? event.currentModeId;
      const config: SessionConfigState = {
        ...s.config,
        modeOptions: {
          configId: null,
          selected,
          available: event.availableModes.map((mode) => ({
            id: mode.id,
            name: mode.name,
            // SDK 允许 description 为 null;状态 schema 只收 string|absent ⇒ null 与 undefined 都收敛为缺席。
            ...(mode.description != null ? { description: mode.description } : {}),
          })),
        },
      };
      return { ...s, config, pendingModeId: null };
    }
    case 'commands': {
      const availableCommands = event.commands.map((c) => {
        const raw = c as unknown as {
          name: string;
          description: string;
          input?: { hint?: string };
        };
        const cmd: SessionCommand = {
          name: raw.name,
          description: raw.description,
          source: 'provider-command',
        };
        if (raw.input?.hint) cmd.inputHint = raw.input.hint;
        return cmd;
      });
      return { ...s, config: { ...s.config, availableCommands } };
    }
    case 'usage': {
      // The account's limit is reported only when it changes: a usage update without one keeps the last (G3).
      const rateLimit = event.usage.rateLimit ?? s.usage?.rateLimit;
      return { ...s, usage: rateLimit ? { ...event.usage, rateLimit } : event.usage };
    }
    case 'title':
      return { ...s, title: event.title };
    case 'agent_state':
    case 'transcript_path':
    case 'prompt_result':
    case 'interrupted_for_message':
    case 'terminal_update':
    case 'terminal_chunk':
    case 'ignored':
      return s;
    case 'terminal_snapshots': {
      const committed = s.transcript.committed.map(turn => withReferencedTerminals(turn, event.terminals));
      return committed.some((turn, index) => turn !== s.transcript.committed[index])
        ? { ...s, transcript: { ...s.transcript, committed } } : s;
    }
    case 'subagent_update': {
      // ⚠️ 只更新登记册,**从不回头去改转录里那一行**。
      //
      // 那一行是「启动子智能体」这次调用,它在启动返回的那一刻就完成了;这条通知说的是
      // 另一件事 —— 那个智能体跑完了。owner 2026-09-06:「其实无非是 toolcall 和
      // notification」。先前这里还顺手把转录行改成完成(settleSubagentItem,已撤),
      // 那是把两件事焊成一个需要有人记得去落定的活组件。
      const agents = updateAgentSlice(s.agents, event, s.transcript.active?.id ?? null, input.at);
      return agents === s.agents ? s : { ...s, agents };
    }
    default:
      break; // falls through to transcript handling below
  }

  let t = s.transcript;
  let segment = s.segment;
  const plan = updatePlanSlice(s.plan, event, input.at);
  let agents = s.agents;

  // The wall clock to stamp on any turn opened below. During replay `input.at`
  // is the moment we are rebuilding history, not the moment it happened, so
  // there is nothing truthful to stamp — see TranscriptTurn.startedAt.
  const openedAt = s.replaying ? undefined : input.at;

  // OPEN boundary: a new user message starts a new turn.
  if (event.kind === 'message' && event.role === 'user' && event.steering !== true) {
    if (isNewUserMessage(t.active, event, segment)) {
      t = closeActive(t, input.at, undefined, openedAt);
      t = openTurn(t, deps, 'user', openedAt, event.trigger);
      segment = initialSegment();
    }
  }

  // 「任务跑完了」的通知不只子智能体会发:后台跑的 Bash 命令(`run_in_background`)
  // 走的是**同一条** task_notification 通道,而通知本身不带任务类型(SDK 0.3.197 的
  // task_notification 只有 task_id / tool_use_id / status / summary / output_file)。
  // 2026-09-06 真机:子智能体内部起了一条后台 `sleep 40`,它的通知冒上来被当成第二个
  // 「子智能体已完成」,行名落成任务 id `bxkfon8z4`。
  //
  // 它是谁,只有转录知道 —— 按 tool_use_id 找那次调用:
  //   · 派发调用 / 登记册里有 → 子智能体跑完了(下面照旧成行);
  //   · 别的调用(后台命令)→ 归还给那张命令卡:状态 + 输出落到它自己身上,❌ 不另起一行
  //     (owner 2026-09-06:「background command 可能也是要放到输出卡片上」);
  //   · 谁也对不上 → 不是我们知道的任务,丢弃,❌ 编一行。
  let resolvedEvent: typeof event = event;
  if (event.kind === 'subagent_done') {
    const target = resolveTaskNotification(event, agents, t);
    if (target === null) return s;
    resolvedEvent = target;
  }
  if (
    event.kind === 'async_task' ||
    event.kind === 'async_task_progress' ||
    event.kind === 'async_task_state'
  ) {
    const target = resolveAsyncTask(event, t);
    if (target === null) return s;
    resolvedEvent = target;
  }

  // 后台任务的归属/落定要改的那张卡,多半**不在当前轮**:这是协议本意 —— 0.75.1 只为
  // **子智能体**推迟收口(`Turn.deferredSettle`,源码注释「held for background subagents it
  // spawned」),后台 Bash 的轮当场收口,终态之后单独到根会话(真机 `raw-aae46e84.json`:
  // 派发后 9 秒 end_turn,60 秒后才到 `async_task_state_update`)。fold 只认当前轮,找不到就
  // 新建一行 —— 那一行就是 owner 2026-09-07 截图里凭空多出的「工具」,而真正该改的卡一直没动,
  // 摘要栏那张 `sleep 60` 于是永远在跑。⇒ 卡在已落定的轮里就**就地改它**,不进 fold。
  //
  // ⚠️ `stopped` 可能只是暂定:适配器收到 SDK 的后台任务清单(replace 语义)发现某任务不在
  // 里面,会先**尽力而为**地发 `stopped`,紧接着由 task_notification 纠正成 completed/failed
  // (async-tasks.js `backgroundTasksChanged` 注释原话)。所以顺序应用、后到的赢,❌ 别把第一条
  // `stopped` 当定论去做不可逆的事。
  if (
    resolvedEvent.kind === 'tool_update' &&
    (resolvedEvent.backgroundTaskDone !== undefined || resolvedEvent.backgroundTaskId !== undefined) &&
    findToolCallNode(t.active?.items ?? [], resolvedEvent.toolCallId) === null
  ) {
    const committed = patchToolCallInTurns(t.committed, resolvedEvent);
    if (committed !== null) {
      const patched: ParserState = { ...s, transcript: { ...t, committed }, segment, agents, plan };
      const done = backgroundCommandDone(resolvedEvent, t);
      return done ? reduce(patched, { kind: 'event', event: done, at: input.at }, deps) : patched;
    }
  }

  // 命令卡就在当前轮:照常 fold 到卡上,再补一行「跑完了」(见 backgroundCommandDone)。
  const commandDoneAfterFold =
    resolvedEvent.kind === 'tool_update' && resolvedEvent.backgroundTaskDone === true
      ? backgroundCommandDone(resolvedEvent, t)
      : null;

  // Lazy open: agent-initiated content with no active turn.
  if (!t.active) {
    t = openTurn(t, deps, 'agent', openedAt, { kind: 'agent' });
    segment = initialSegment();
  }

  const materialized = materializeEvent(t, segment, resolvedEvent, input.at);
  t = materialized.transcript;
  segment = materialized.segment;

  const active = t.active!;
  agents = updateAgentSlice(agents, materialized.event, active.id, input.at);
  // 「那个子智能体跑完了」这一行要写出**它是谁**,而通知本身不带名字。名字是派发那条
  // 事件带来的、记在登记册里的 —— 所以在这儿按 toolCallId 查一次交给 fold。
  // ❌ 不去解析 `Agent "X" finished` 那句英文散文反推名字:那是供应商的文案,改一次措辞
  // 就静默失灵,而登记册是我们自己按结构化事件建的。查不到就留空,行上落到通用词。
  const foldEvent =
    materialized.event.kind === 'subagent_done'
      ? withAgentName(materialized.event, agents)
      : materialized.event;
  const items = foldItem(
    active.items,
    foldEvent,
    active.id,
    input.at,
    s.replaying ? undefined : input.at
  );

  if (
    items === active.items &&
    t === s.transcript &&
    segment === s.segment &&
    agents === s.agents &&
    plan === s.plan
  ) {
    return s;
  }
  const transcript: TranscriptSlice =
    items === active.items ? t : { ...t, active: { ...active, items } };
  assertTranscriptInvariants(transcript);
  const next: ParserState = { ...s, transcript, segment, agents, plan };
  return commandDoneAfterFold
    ? reduce(next, { kind: 'event', event: commandDoneAfterFold, at: input.at }, deps)
    : next;
}

/**
 * 后台命令的终态到了 ⇒ 派生一行「跑完了」(#5117)。子智能体的卡不在此列 —— 它的那一行由
 * `subagent_done` 立。归属对不上任何卡也不立(那种早在 resolve* 里就被丢了,这里只是双保险)。
 */
function backgroundCommandDone(
  event: Extract<NormalizedEvent, { kind: 'tool_update' }>,
  t: TranscriptSlice
): Extract<NormalizedEvent, { kind: 'background_command_done' }> | null {
  if (event.backgroundTaskDone !== true) return null;
  const card =
    findToolCallNode(t.active?.items ?? [], event.toolCallId) ??
    findToolCallNodeInTurns(t.committed, event.toolCallId);
  if (card === null || card.kind === 'spawn-subagent-tool-call') return null;
  const title = (card as { title?: unknown }).title;
  return {
    kind: 'background_command_done',
    toolCallId: event.toolCallId,
    name: typeof title === 'string' ? title : '',
    outcome: event.status === 'failed' ? 'failed' : 'completed',
    ...(event.outputText != null ? { summary: event.outputText } : {}),
  };
}
