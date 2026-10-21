import { and, eq } from 'drizzle-orm';
import { isProviderSessionMissingError } from '@gugu/session-core/acp';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { resolveSession } from '../projects/utils';
import { mapSessionRowToSession } from './utils';
import { markProviderSessionMissing } from './mark-provider-session-missing';
import { clearProviderSessionId, setProviderSessionId } from './set-session-id';

export async function hydrateSession(
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

  const session = mapSessionRowToSession(row);

  if (session.runtime === 'acp') {
    return;
  }
  if (session.providerSessionState === 'missing') return;

  // PTY path.
  const mount = resolveSession(projectId, sessionId);
  if (!mount) throw new Error('Session not found');

  const isFirstSpawn = row.providerSessionId === null;

  if (isFirstSpawn) {
    // Write session_id before spawning — idempotency guard against double-hydrate.
    //
    // ⚠️ 走 `setSessionId`(会发 `session:changed`),❌ 不要退回裸 `db.update`。
    // 这一格是「这条会话要续哪个 provider 会话」,渲染进程手里也留着一份;裸写的那版里,
    // 本次 app 运行内新建的编程模式会话在渲染端**恒为空**,而记录里其实早就有值 ——
    // 记录与渲染端就此分叉,且两边都不报错(#5869)。
    const claimed = await setProviderSessionId(sessionId, sessionId);
    if (!claimed.success) {
      throw new Error(
        `session ${sessionId} could not claim its session id: ${claimed.error.type}`
      );
    }
  }

  const config = row.config;
  const isResuming = !isFirstSpawn;

  try {
    await mount.sessions.startSession(
      mapSessionRowToSession(row, isResuming),
      undefined,
      isResuming,
      isFirstSpawn ? config?.initialPrompt : undefined
    );
  } catch (error) {
    if (
      row.providerSessionId &&
      isProviderSessionMissingError(error, { resumingProviderSessionId: row.providerSessionId }) &&
      (await markProviderSessionMissing(sessionId, row.providerSessionId))
    ) {
      return;
    }
    if (isFirstSpawn) {
      // 启动没成就把刚才那笔「已启动」的账退回去。
      //
      // 上面那次预写是幂等闸(挡并发重复 spawn),记的是**认领**而不是**事实**;不退账,
      // 这条会话就永远停在「已记账、但从没真启动」——下一次打开按 isResuming 走,跳过 fresh
      // 启动路径该做的准备。真机上撞到过:codex 因为 PATH 里没有 node 起不来,一次失败就把四条
      // 会话变成砖,而后续报错离真因两级远。
      //
      // ❌ 不能改成「启动成功后才写」:那会放开幂等闸,两个并发 hydrate 都会 spawn。
      // 认领先写、失败退回,两个性质都保住。
      //
      // 退账同样经 `clearSessionId` 广播出去 —— 认领那次已经让渲染端记下了这个 id,
      // 不撤回的话它会一直以为有一条可续的 provider 会话(理由见 setSessionId 那侧的抬头)。
      //
      // ⚠️ 第二个参数是「我当初认领的是哪个 id」:spawn 要起好几秒,而 `fork-capture` 每 5 秒扫一趟,
      // 这段窗口里它完全可能把一个**真的** provider 会话 id 绑上来。无条件清空会把那条真会话抹掉,
      // 而用户什么都没做。带上期望值 ⇒ 只退自己那笔,别人写过的就留着。
      await clearProviderSessionId(sessionId, sessionId);
    }
    throw error;
  }
}
