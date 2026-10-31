import { and, eq, like } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessionPending, sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { agentStatusWriter } from '@main/core/agent-status/agent-status-writer';
import type { SessionConfig } from '@shared/core/sessions/session-config';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';
import { hydrateSession } from './hydrateSession';
import { sessionLife } from './session-life';

/**
 * spec session-resume:引擎侧什么都没有的会话,**照咕咕记着的那句首轮重来**(= restart)。
 *
 * 走到这里的只有两种会话,它们留下的是同一种状态:首轮没跑完的(建完就关、首轮本身失败),
 * 和跑完过但引擎侧那条会话后来没了的(rollout 被删、被归档)。两种都不是故障,缺的是
 * 一次尚未发生的启动 —— 报「无法加载对话」才是把可自愈的状态渲染成了故障。
 *
 * ❌ 不是「新建一条顶上」:会话 id、标题、在任务里的位置全都原样保留,用户看到的是
 * 「这句话正在重新跑」,不是一条凭空多出来的会话。
 */
export async function restartSession(
  projectId: string,
  sessionId: string
): Promise<void> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.projectId, projectId),
      )
    )
    .limit(1);
  if (!row) throw new Error('Session not found');
  if (!row.config) throw new Error(`Session has no config: ${sessionId}`);
  // ACP: this restart's replay is numbered by the replays the engine already took. Until it takes this one, another
  // 重来 (a second press, another window) is this same restart: nothing to rest, nothing to enqueue again.
  const replayId = row.runtime === 'acp' ? `${sessionId}:restart:${acceptedReplays(sessionId)}` : null;
  if (replayId && db.select({ seq: sessionPending.seq }).from(sessionPending)
    .where(and(eq(sessionPending.sessionId, sessionId), eq(sessionPending.messageId, replayId))).get()) return;

  // 记着的首轮:优先用还留在载荷里的那份(它本来就是要投递的那句),否则用创建时记下的事实。
  const replay = row.config.initialPrompt?.trim() || row.config.firstUtterance?.trim();
  if (!replay) {
    // 新建恒带首轮之后这里够不到 —— 会走到这条的只有那批存量空壳会话。fail loud:
    // ❌ 不静默换一条新会话冒充成功(spec session-resume 底线)。
    throw new Error(
      `[session-resume] 这条会话没有可重来的首轮:${sessionId}。` +
        `它建出来时就没带第一句话(存量数据),既恢复不了也重来不了,只能删。`
    );
  }

  // providerSessionState 必须整键去掉,而不是置 undefined —— 版本化 JSON 列写的是
  // JSON.stringify 的结果,一个 `undefined` 值会连键一起消失,但显式留键更容易被下一个人
  // 误读成「有这个状态,只是空的」。
  const { providerSessionState: _cleared, ...rest } = row.config;
  // ACP replays through session-life's queue (below) only: its creation turns go too, or a session created before
  // session-life (no earlier pending row) would get them enqueued again at provision. A terminal leg's hydrate
  // reads initialPrompt.
  let nextConfig: SessionConfig;
  if (rest.type === 'acp') {
    const { initialQueue: _replayed, ...acp } = rest;
    nextConfig = acp;
  } else nextConfig = { ...rest, initialPrompt: replay };

  await db
    .update(sessions)
    .set({
      config: nextConfig,
      // sessionId 归零 = 下一次启动按「首次启动」走(hydrateSession 用的就是这把尺子)。
      providerSessionId: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(sessions.id, sessionId));
  // 重开 = 这句话重新跑:一次出生,经状态写入者写库、播出。
  await agentStatusWriter.restart({ sessionId, projectId });

  events.emit(sessionChangedChannel, {
    sessionId,
    projectId,
    // `sessionId` 清空用 `null` 而不是 `undefined` —— JSON 传输会把值为 undefined 的键整个丢掉,
    // 于是网页宿主那条上「清空」变成「什么都没说」(见 sessionChangedChannel 的抬头)。
    // `providerSessionState` 同一个坑、同一个写法(#7223 收的)。
    changes: { providerSessionState: null, providerSessionId: null },
  });

  log.info('restartSession: replaying the recorded first utterance', {
    sessionId,
    type: row.runtime,
  });

  // pty 在主进程这边就地重起。ACP: the replay is a new pending row (the first run's row was accepted: reusing its id
  // would be a no-op). A reconfigure first rests a run and leaves a failure, so the replay starts a fresh run on the
  // cleared provider session and is delivered once.
  if (replayId) {
    await sessionLife().interrupt(sessionId, { k: 'interrupt', reason: 'reconfigure' });
    sessionLife().enqueue({ sessionId, messageId: replayId, text: replay, kind: 'ordinary',
      turn: { kind: 'prompt', origin: 'manual' } });
  } else {
    await hydrateSession(projectId, sessionId);
  }
}

function acceptedReplays(sessionId: string): number {
  return db.select({ seq: sessionPending.seq }).from(sessionPending)
    .where(and(eq(sessionPending.sessionId, sessionId), eq(sessionPending.state, 'accepted'), like(sessionPending.messageId, `${sessionId}:restart:%`)))
    .all().length;
}
