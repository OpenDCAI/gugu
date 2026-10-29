import {
  sessionStateSchema,
  sessionSummarySchema,
  transcriptTurnSchema,
  type TranscriptTurn,
  type QueuedPrompt,
  type SessionState,
  type SessionSummary,
} from '@gugu/session-core/acp';
import type { PendingRequest } from '@gugu/session-core/session-record/contract';
import { permissionToPendingRequest } from '@gugu/session-core/session-record/live-requests';
import { ReplicaState } from '@gugu/session-wire';
import { z } from 'zod';
import { liveReplyOf, type SessionLiveReply } from '@gugu/session-core/session-record/live-reply';
import { peekAcpRuntimeClient, onAcpRuntimeSpawned } from '@main/core/acp/runtime-process/host';
import { log } from '@main/lib/logger';

const sessionSummaryListSchema = z.record(z.string(), sessionSummarySchema);

/**
 * 活运行时里「此刻正在等人回答」的那些审批请求。
 *
 * 为什么读侧拿不到：ACP 的审批是 `session/request_permission` —— 一条**请求应答**。它不进
 * 会话记录，只有当时连着的那个 ACP 客户端看得见。记录里留下的只有触发它的那条工具调用，
 * 而工具调用本身并不说明「它卡在这儿等人」。所以桌面端画得出审批卡、手机端一张都画不出，
 * 不是渲染问题，是那条信息根本没进读侧。
 *
 * 这一层就是把它接进来：订阅运行时的 `session.state`，把 `pendingPermissions` 整份喂给时间线。
 * 排队提示（`queuedPrompts`）同理：ACP 腿的队列在运行时里、不进记录，桌面「Queued prompts」画的就是这一份，
 * 手机看到的要是同一份。
 *
 * ⚠️ 用 `peekAcpRuntimeClient()` 而不是 `getAcpRuntimeClient()`：后者**为了看一眼会先把运行时进程
 * 拉起来**。没起来 ⇒ 这台机器上一条 ACP 会话都不活着 ⇒ 待答的审批必然是零，把进程叫起来
 * 只是为了让它回答「没有」。
 */

export type SessionStateWatch = { dispose(): void };

/**
 * 订阅一条会话的待答审批与排队提示。
 *
 * 返回 `null` = **这台机器上没有 ACP 运行时进程**（区别于「有运行时、但这条会话没有待答项」，
 * 后者走 `onChange([], [])`）。调用方据此知道自己拿到的是"确实没有"还是"没接上"。
 *
 * @@@follow-session-list 时间线常常**先于**这条 ACP 会话被打开 —— 聊天页在 agent 一映射上就订阅,
 * 而会话的 cell 要等首句才建。那一刻去订 `session.state` 只会拿到 NOT_FOUND,之后这条会话的审批
 * 就再也进不了时间线(聊天页永远等不到批准入口,2026-09-23 实测)。⇒ 跟着运行时的会话表走:
 * 会话出现就接上它的 `session.state`,消失就拆掉并报空。❌ 不靠定时重试去「等它出现」。
 */
async function watchRunningSessionState(
  sessionId: string,
  onChange: (requests: PendingRequest[], queuedPrompts: QueuedPrompt[], liveReply: SessionLiveReply | null, activeTurn?: TranscriptTurn | null) => void
): Promise<SessionStateWatch | null> {
  const client = await peekAcpRuntimeClient();
  if (!client) return null;

  let state: SessionState | null = null;
  let turn: TranscriptTurn | null = null;
  let activeTurn: ReplicaState<TranscriptTurn | null> | null = null;
  const emitLatest = () => {
    if (state) onChange(state.pendingPermissions.map(permissionToPendingRequest), state.queuedPrompts, state.isGenerating ? liveReplyOf(turn) : null, turn);
  };
  const emit = (next: SessionState) => { state = next; emitLatest(); };

  let session: ReplicaState<SessionState> | null = null;
  const attachSession = () => {
    const replica = new ReplicaState<SessionState>(client.session.state({ sessionId }, 'state'), {
      schema: sessionStateSchema,
      onChange: (next) => { if (session === replica) emit(next); },
    });
    session = replica;
    const active = new ReplicaState<TranscriptTurn | null>(client.session.state({ sessionId }, 'activeTurn'), {
      schema: transcriptTurnSchema.nullable(),
      onChange: (next) => { if (activeTurn === active) { turn = next; emitLatest(); } },
    });
    activeTurn = active;
    void active.ready.then(() => {
      if (activeTurn === active) { turn = active.current(); emitLatest(); }
    }, (error: unknown) => {
      if (activeTurn !== active) return;
      turn = null;
      emitLatest();
      log.warn('sessionTimeline: live reply unavailable', { sessionId, error: String(error) });
    });
    // 首帧也要喂：`onChange` 只在**变化**时响，而订阅上来那一刻可能已经有一条在等人了
    // （手机是后进来的旁观者，审批多半早它一步发生）。
    void replica.ready.then(
      () => {
        if (session === replica) emit(replica.current());
      },
      (error: unknown) => {
        log.warn('sessionTimeline: failed to attach pending permissions of a live session', {
          sessionId,
          error: String(error),
        });
        // 放掉这份死副本,会话表下一次变化时再接 —— 否则 `follow` 以为已经接上,永远不再试。
        if (session === replica) {
          session = null;
          state = null;
          turn = null;
          if (activeTurn === active) activeTurn = null;
          void active.dispose();
          void replica.dispose();
          onChange([], [], null);
        }
      }
    );
  };
  const detachSession = () => {
    const replica = session;
    if (!replica) return;
    session = null;
    state = null;
    turn = null;
    const active = activeTurn;
    activeTurn = null;
    if (active) void active.dispose();
    void replica.dispose();
    onChange([], [], null);
  };
  // `sessions.list` 里有记录 ≠ 还活着:结束的会话留在表里、lifecycle 变 closed,它的 session.state
  // 已经没了(同一条判据见 live-options.ts 的 readConfig)。
  const follow = (list: Record<string, SessionSummary>) => {
    const lifecycle = list[sessionId]?.lifecycle;
    const live = lifecycle !== undefined && lifecycle !== 'closed' && lifecycle !== 'lost';
    if (live && !session) attachSession();
    else if (!live && session) detachSession();
  };

  const sessions = new ReplicaState<Record<string, SessionSummary>>(
    client.sessions.state(undefined, 'list'),
    { schema: sessionSummaryListSchema, onChange: follow }
  );
  await sessions.ready;
  follow(sessions.current());
  return {
    dispose: () => {
      void sessions.dispose();
      const replica = session;
      session = null;
      if (replica) void replica.dispose();
      const active = activeTurn;
      activeTurn = null;
      state = null;
      turn = null;
      if (active) void active.dispose();
    },
  };
}

/** A timeline may open before its runtime, or survive a model switch that replaces that runtime. */
export async function watchSessionState(
  sessionId: string,
  onChange: (requests: PendingRequest[], queuedPrompts: QueuedPrompt[], liveReply: SessionLiveReply | null, activeTurn?: TranscriptTurn | null) => void
): Promise<SessionStateWatch> {
  let disposed = false;
  let generation = 0;
  let current: SessionStateWatch | null = null;
  const attach = async () => {
    const own = ++generation;
    current?.dispose();
    current = null;
    if (!disposed) onChange([], [], null);
    try {
      const next = await watchRunningSessionState(sessionId, (requests, queue, reply, activeTurn) => {
        if (!disposed && generation === own) onChange(requests, queue, reply, activeTurn);
      });
      if (disposed || generation !== own) next?.dispose();
      else current = next;
    } catch (error) {
      if (!disposed && generation === own) {
        onChange([], [], null);
        log.warn('sessionTimeline: live runtime watch unavailable', { sessionId, error: String(error) });
      }
    }
  };
  const stop = onAcpRuntimeSpawned(() => { if (!disposed) void attach(); });
  await attach();
  return { dispose: () => { disposed = true; generation++; stop(); current?.dispose(); current = null; } };
}
