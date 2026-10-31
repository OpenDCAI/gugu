import { and, eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import {
  MAX_SESSION_TITLE_LENGTH,
  type Session,
} from '@shared/core/sessions/sessions';
import { attachAgentToSession } from './attach-agent-to-session';
import { mapSessionRowToSession } from './utils';

export type ForkSessionParams = {
  projectId: string;
  /** 被分叉的那条会话。新会话的一切(引擎、模型、权限档、上下文)都抄它。 */
  sourceSessionId: string;
};

/**
 * spec session-fork-share:分叉 = 同一个 provider 的一条新 pty 会话,以自己的会话 id
 * resume 源会话的上下文。**零输入** —— 它继承的是已有会话,不需要第一句话,所以它是
 * 「新建必带首轮」之外的**另一个动词**,而不是给新建开一个豁免参数。
 *
 * 载荷在主进程这边拼:标题、模型、权限档都抄源会话行。渲染端只交出「分叉哪条」——
 * 一个只能表达「照抄这条」的入口,没法被拿来造一条凭空的会话。
 */
/**
 * 分叉要的是**来源的 provider 会话 id**,而两种 runtime 在「还没启动过」这一档上不同:
 * pty 首启会把自己的会话 id 当 provider session id 认领下来,所以退回 `source.id` 是对的;
 * ACP 的 provider 会话 id 由 agent 在 `session/new` 时给,没启动过就是**真的没有**。
 */
function providerSessionIdForFork(source: Session): string {
  if (source.providerSessionId) return source.providerSessionId;
  if (source.runtime === 'acp') {
    throw new Error(
      'fork needs the source session to have started at least once (no provider session id yet)'
    );
  }
  return source.id;
}

export async function forkSession(params: ForkSessionParams): Promise<Session> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.id, params.sourceSessionId), eq(sessions.projectId, params.projectId))
    )
    .limit(1);
  if (!row) throw new Error('Session not found');

  const source = mapSessionRowToSession(row);
  const name = `${source.title}-fork`.slice(0, MAX_SESSION_TITLE_LENGTH);
  // 先把「这次分叉成不成立」说清楚,再落任何一行。
  const forkFromProviderSessionId = providerSessionIdForFork(source);
  // #6269 分叉出来的会话是一条独立会话,工作目录与来源同一行 workspace(与 session_spawn / 扩展派活同一处)。
  if (!source.workspaceId) throw new Error('source session workspace is not ready');

  // spec session-fork-share:「任意会话可 fork」——**分叉出来的会话与来源同 runtime**。
  // ⚠️ ❌ 不许跨 runtime:ACP 的会话 id 拿到 pty 里 resume 是无意义的,那会起一条自称
  // 「照抄了上下文」、实际什么都没继承的会话。判据留在这里,而不是只长在菜单可见性上 ——
  // 菜单之外的调用方(命令、扩展)绕过去就静默造出这种会话。
  return attachAgentToSession({
    projectId: params.projectId,
    workspaceId: source.workspaceId,
    provider: source.providerId,
    agentDisplayName: name,
    origin: {
      kind: 'fork',
      forkedFrom: { sessionId: source.id },
    },
    // 分叉照抄源会话的权限档 —— 分出来的会话不该比原来更放权,也不该更受限。
    ...(source.permissionMode !== undefined && { permissionMode: source.permissionMode }),
    model: source.model,
    runtime: source.runtime ?? 'pty',
    // 源会话还没启动过时它没有 provider 会话 id。
    // pty:退回自己的 id —— 与产品里 pty 首启认领 session_id 的口径一致(那条 id 就是它的)。
    // ACP:❌ 不许退回 —— 会话 id 不是 provider 会话 id,拿它去 `session/fork` 找不到东西,
    //     而失败要等到用户打开这条分叉时才现形。没启动过就当场说清楚:先开一下再分叉。
    forkFromProviderSessionId,
  });
}
