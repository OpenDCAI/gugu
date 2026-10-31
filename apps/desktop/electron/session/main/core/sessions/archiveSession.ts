import { sessionBootTasks } from '../boot-tasks';
import { drainSessionMessageOutbox } from './sendMessage';
import { and, eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { projects, sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { sessionEvents } from './session-events';
import { getAcpRuntimeClient } from '@main/core/acp/controller';
import { projectManager } from '@main/core/projects/project-manager';
import { cleanupDetachedSessions, sessionWorkspaceManager } from './session-workspace-manager';
import { log } from '@main/lib/logger';
import { setSessionArchival, sessionArchivalState, serializeSessionArchival } from './session-archival';
import { sessionIdentityHost } from './session-identity-host';
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
 * 移出身份先取得云端收据,再本地封住投递并停 runtime;保留身份时沿原离线同步。
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
  options: { withChildren?: boolean; skipTransportStop?: boolean; removeSocialIdentity?: boolean } = {}
): Promise<ArchiveOutcome> {
  if (options.removeSocialIdentity !== undefined && typeof options.removeSocialIdentity !== 'boolean') throw new Error('removeSocialIdentity must be a boolean');
  const [row] = await db
    .select({ archivedAt: sessions.archivedAt })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.projectId, projectId)))
    .limit(1);
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  if (row.archivedAt && options.removeSocialIdentity === false) return { archived: [], unreached: [] };

  const { members, unreached } = options.withChildren
    ? await familyOf(sessionId)
    : { members: [], unreached: [] };
  const archived: ArchivedSessionRef[] = [];
  for (const member of members) {
    if (member.deviceId === null) {
      archived.push(...(await archiveOne(member.projectId, member.id, false, options.removeSocialIdentity)));
    } else if (await archiveOnOtherMachine(member.deviceId, member, unreached, options.removeSocialIdentity)) {
      archived.push({ projectId: member.projectId, sessionId: member.id });
    }
  }
  archived.push(...(await archiveOne(projectId, sessionId, options.skipTransportStop, options.removeSocialIdentity)));
  return { archived, unreached };
}

/**
 * 本机的一条:状态和拒投区间一起落库,再停运行时。工作区保留;身份按显式选项处理。
 */
async function archiveOne(projectId: string, sessionId: string, skipTransportStop = false, removeSocialIdentity = true): Promise<ArchivedSessionRef[]> {
  return serializeSessionArchival(sessionId, () => archiveOneLocked(projectId, sessionId, skipTransportStop, removeSocialIdentity));
}

/** Caller holds serializeSessionArchival. */
export async function archiveOneLocked(projectId: string, sessionId: string, skipTransportStop: boolean, removeSocialIdentity = true): Promise<ArchivedSessionRef[]> {
  const [row] = await db
    .select({ runtime: sessions.runtime, archivedAt: sessions.archivedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row) return [];
  const previous = sessionArchivalState(sessionId)!;
  if (row.archivedAt && !removeSocialIdentity) return [];
  // No local half state: failed/offline identity removal leaves this task unarchived.
  const removedIdentity = previous.removedIdentity ?? (removeSocialIdentity ? await sessionIdentityHost().archive(sessionId) : null);
  if (row.archivedAt && !removedIdentity) return [];
  const archivedAt = row.archivedAt && previous.removedIdentity
    ? row.archivedAt : setSessionArchival(sessionId, true, new Date().toISOString(), removedIdentity);

  events.emit(sessionChangedChannel, {
    sessionId,
    projectId,
    changes: { archivedAt },
  });
  sessionEvents._emit('session:archived', sessionId);
  await stopSessionRuntime(projectId, sessionId, row.runtime, skipTransportStop);
  if (removedIdentity) await sessionIdentityHost().release(removedIdentity);
  await publishProjectVisibility(projectId);
  return row.archivedAt && previous.removedIdentity ? [] : [{ projectId, sessionId }];
}

/**
 * 恢复同一个任务;已移除的身份经宿主共用 provisioning 换成新身份。若存在持久 pending 消息，锁释放后仅排一次自己的 outbox；
 * 没有 pending 消息不启动运行时，dispatching 收据不重放。
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
  const restored = await serializeSessionArchival(sessionId, () => restoreSessionLocked(projectId, sessionId));
  // Run after releasing the archival lock: the existing router may wake this task through that lock.
  // Restore admits the retained outbox exactly once, without replaying any dispatching receipt.
  await sessionBootTasks.run('restore-outbox', sessionId, () => drainSessionMessageOutbox({ projectId, sessionId }));
  return restored;
}

async function restoreSessionLocked(projectId: string, sessionId: string): Promise<Session> {
  const [row] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.projectId, projectId)))
    .limit(1);
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  const removedIdentity = sessionArchivalState(sessionId)?.removedIdentity;
  if (removedIdentity) await sessionIdentityHost().restore({ projectId, sessionId }, removedIdentity);
  // A closed interval and the restored row become visible in one transaction.
  db.transaction((tx) => {
    setSessionArchival(sessionId, false);
    tx.update(projects).set({ archivedAt: null }).where(eq(projects.id, projectId)).run();
  });
  const restored = db.select().from(sessions).where(eq(sessions.id, sessionId)).get()!;

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

/**
 * 归档时停掉任务的运行时:挂着就拆它的挂载(会话进程、它的终端、ACP 那条腿,工作区
 * 按引用计数放掉);没挂载就直接收 ACP 会话 / tmux 会话。
 *
 * 拆挂载失败只记一笔:那条路失败时自己已经把这条会话的 tmux 会话收掉了(session-workspace-manager 的兜底)。
 * 没挂载的 ACP 会话停不下来就抛 —— 一条还在跑的会话被从列表里收起,人再也点不到它,却仍在花钱。
 *
 * `skipTransportStop`:provider 从没启动过(spawn 的补偿路径),只拆挂载,不去停一个不存在的进程。
 */
async function stopSessionRuntime(
  projectId: string,
  sessionId: string,
  runtime: string | null,
  skipTransportStop = false
): Promise<void> {
  if (sessionWorkspaceManager.getSession(sessionId)) {
    const result = await sessionWorkspaceManager.teardownSession(sessionId, 'archive');
    if (!result.success) {
      log.warn('stopSessionRuntime: teardown failed', { sessionId, error: result.error.message });
    }
    return;
  }
  if (skipTransportStop) return;
  if (runtime === 'acp') {
    const result = await (await getAcpRuntimeClient()).stopSession({ sessionId });
    if (!result.success) throw new Error('failed to stop ACP session');
    return;
  }
  const project = projectManager.getProject(projectId);
  if (project) await cleanupDetachedSessions(projectId, sessionId, project.ctx);
}
