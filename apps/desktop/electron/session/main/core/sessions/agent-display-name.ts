// spec agent-provisioning「命名即寻址名」的**读侧**:session start 那一刻,宿主要知道这条会话有没有被
// 显式命名过 —— 有,那个名字就是它在咕咕通讯录里的显示名;没有,才落到「<引擎 label> <序号>」。
//
// 事实本身在创建时就记在会话 config 上(spec session-graph 的 `spawn.title`),这里只负责读回来。
// ❌ 不读 `sessions.title`:那个字段到这一层已经和 `defaultTitle(prompt)` 推出来的标题同形,
// 读它等于把一整行提示词当人名 —— 这正是把「显式」这条事实单独持久化的理由。
import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';

/** 这条会话被显式命名过的那个名字;没有就是 undefined。 */
export async function sessionAgentDisplayName(
  sessionId: string
): Promise<string | undefined> {
  const [row] = await db
    .select({ config: sessions.config })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row?.config?.agentDisplayName?.trim() || undefined;
}
