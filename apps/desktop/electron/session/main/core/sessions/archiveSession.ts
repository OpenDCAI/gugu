import { and, eq, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { sessionEvents } from './session-events';
import { stopSessionRuntime } from './deleteSession';
import { archiveOnOtherMachine, familyOf } from './session-family';
import { mapSessionRowToSession } from './utils';
import { publishProjectVisibility } from '../projects/operations/project-visibility';
import type {
  ArchivedSessionRef,
  ArchiveOutcome,
  Session,
} from '@shared/core/sessions/sessions';
import {
  sessionChangedChannel,
  sessionCreatedChannel,
} from '@shared/core/sessions/sessionEvents';

/**
 * spec session-graph:归档的归属键是**这条会话自己**。用户看见的标签说「归档任务」——在他心智里
 * 会话列表的一行就是一项任务(owner 2026-09-11)——而产品动的是这条 conversation。
 *
 * 停 runtime 的顺序与删除一致:先停,再落库(`stopSessionRuntime`)。
 *
 * 返回**这一次真正收走的行**(子会话在前、点名的在后;已经归档的不算):归档提示里的「撤销」按这份清单
 * 原样放回(#6083),❌ 由渲染侧自己猜范围。
 *
 * 子树按父子关系找(父会话这条边、传递、哪台机器上的都算,见 session-family),每一条走它所在机器上的单条归档
 * (owner 2026-10-01「一起收」「链路统一」):叶子先、点名的最后。别的机器上收走的行也在清单里(撤销按行所在的
 * 项目走回那台机器);够不着的机器在 `unreached` 里说出来。
 *
 * 「子会话」只有一种:**spawn 出来的**。fork 不在其中 —— `config.forkedFrom` 只是 provider transcript 血缘,
 * fork 与它的来源在所有意义上都是平行同级(owner 2026-09-11)。
 */
export async function archiveSession(
  projectId: string,
  sessionId: string,
  options: { withChildren?: boolean } = {}
): Promise<ArchiveOutcome> {
  const [row] = await db
    .select({ archivedAt: sessions.archivedAt })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.projectId, projectId)))
    .limit(1);
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  if (row.archivedAt) return { archived: [], unreached: [] };

  const { members, unreached } = options.withChildren
    ? await familyOf(sessionId)
    : { members: [], unreached: [] };
  const archived: ArchivedSessionRef[] = [];
  for (const member of members) {
    if (member.deviceId === null) {
      archived.push(...(await archiveOne(member.projectId, member.id)));
    } else if (await archiveOnOtherMachine(member.deviceId, member, unreached)) {
      archived.push({ projectId: member.projectId, sessionId: member.id });
    }
  }
  archived.push(...(await archiveOne(projectId, sessionId)));
  return { archived, unreached };
}

/**
 * 本机的一条:先停运行时(工作区留着,恢复后接着用),再落库。已经归档的不算。
 */
async function archiveOne(projectId: string, sessionId: string): Promise<ArchivedSessionRef[]> {
  const [row] = await db
    .select({ runtime: sessions.runtime, archivedAt: sessions.archivedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row || row.archivedAt) return [];

  await stopSessionRuntime(projectId, sessionId, row.runtime, 'archive');

  // 事件里带的是**落库的那个值**,❌ 不是这一刻现造的 ISO 串:渲染端拿它当行的真值用,造一个和库里
  // 不同的时间戳,下一次全量拉取就会把它换掉,中间那段谁也说不清读的是哪一个。
  const [updated] = await db
    .update(sessions)
    .set({ archivedAt: sql`CURRENT_TIMESTAMP`, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(sessions.id, sessionId))
    .returning({ archivedAt: sessions.archivedAt });

  events.emit(sessionChangedChannel, {
    sessionId,
    projectId,
    changes: { archivedAt: updated?.archivedAt ?? null },
  });
  sessionEvents._emit('session:archived', sessionId);
  await publishProjectVisibility(projectId);
  return [{ projectId, sessionId }];
}

/**
 * 恢复只做一件事:把 `archived_at` 抹掉,这条会话回到列表。❌ 不顺手起进程 —— 归档停掉的运行时由人
 * 再打开这条会话时按既有路径重来,恢复不是一个偷偷起 agent 的动词。
 *
 * spec session-graph:会话列表那一片**没有**恢复入口(owner 2026-09-11:「程序内部可以有 restore session 的
 * 接口,但 UI 上的这个区域不需要」)。入口在**另一个区域** —— 「会话历史」面板(#6083),已归档的行从那里
 * 恢复回列表。
 *
 * ⚠️ `archivedAt: null` 只够让还挂着这条会话的 store 更新字段 —— 归档事件到达时每个窗口都已把这一行收起。
 * 所以恢复还要发一声「这一行出现了」(`sessionCreatedChannel`,带整行),每个窗口都按建会话那条路放回:
 * 点恢复的不一定是这台机器的窗口(别的机器上撤销一次跨机器的「连同子会话」,#6873 Z2 实测这台的侧栏不回来)。
 * 也**返回恢复后的那一行**,点恢复的那个窗口当场放回,❌ 等事件绕一圈。
 */
export async function restoreSession(
  projectId: string,
  sessionId: string
): Promise<Session> {
  const [restored] = await db
    .update(sessions)
    .set({ archivedAt: null, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(and(eq(sessions.id, sessionId), eq(sessions.projectId, projectId)))
    .returning();
  if (!restored) throw new Error(`Session not found: ${sessionId}`);

  events.emit(sessionChangedChannel, {
    sessionId,
    projectId,
    changes: { archivedAt: null },
  });
  const session = mapSessionRowToSession(restored, false);
  await publishProjectVisibility(projectId);
  sessionEvents._emit('session:created', session);
  events.emit(sessionCreatedChannel, { session });
  return session;
}
