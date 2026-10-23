import { err, ok, type Result } from '@gugu/session-shared';
import { randomUUID } from 'node:crypto';
import { activitySignal } from '../../activity/signals';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import type {
  BindProjectToGroupResult,
  ProjectGroupBinding,
  ProjectGroupError,
} from '@shared/core/projects/project-groups';
import {
  notifyProjectGroupBindingChanged,
  projectGroupHost,
  type ProjectGroupSubject,
} from '../project-group-host';
import { getProjectById, getProjects } from './getProjects';

/**
 * #7341 第二步 项目跨设备(product spec「挂文件夹」):这台机器上的本地项目各绑一个项目群,绑在同一个群上的
 * 本地项目 = 同一个项目。这里只答会话页知道的那一半(项目在不在、叫什么、里面有哪些没归档的会话),其余交给宿主。
 */

function projectNotFound(projectId: string): ProjectGroupError {
  return { type: 'not-found', message: `没有这个项目:${projectId}` };
}

async function subjectOf(projectId: string): Promise<ProjectGroupSubject | null> {
  const project = await getProjectById(projectId);
  if (!project) return null;
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.projectId, projectId), isNull(sessions.archivedAt)))
    .orderBy(asc(sessions.createdAt), asc(sessions.id));
  return { projectId: project.id, projectName: project.name, sessionIds: rows.map((row) => row.id) };
}

/** 这台机器、当前账号:每个还在的本地项目绑的群。项目没了的那些对照不报(回收器会收)。 */
export async function listProjectGroupBindings(): Promise<Result<ProjectGroupBinding[], ProjectGroupError>> {
  const projectIds = (await getProjects({ includeHidden: true })).map((project) => project.id);
  return projectGroupHost().listBindings(projectIds);
}

/**
 * 这个项目的群:绑过就是它;还没有(从没开过会话)就预留一个,与第一个会话的做法一样 —— 云端的群由第一个进来的 agent
 * 建出来(云端不许建只有群主一个人的群)。幂等:再问一次还是同一个。
 */
export async function ensureProjectGroup(
  projectId: string
): Promise<Result<{ chatId: string }, ProjectGroupError>> {
  const subject = await subjectOf(projectId);
  if (!subject) return err(projectNotFound(projectId));
  const result = await projectGroupHost().ensureGroup(subject);
  if (!result.success) return result;
  if (result.data.changed) {
    activitySignal({ event_id: randomUUID(), kind: 'project.group_bound', object_id: projectId,
      related_object_id: result.data.chatId, occurred_at: Date.now() });
    notifyProjectGroupBindingChanged(projectId);
  }
  return ok({ chatId: result.data.chatId });
}

/**
 * 把这个本地项目并进另一个项目的群(owner 2026-10-17 选 A):这个项目里的 agent 都加进那个群,它原来的群不动、留作历史;
 * 此后这个项目新开的会话进那个群。已经绑在那个群上 = 原样返回(movedAgents 0、previousChatId null)。
 */
export async function bindProjectToGroup(
  projectId: string,
  chatId: string,
  expectedChatId?: string | null
): Promise<Result<BindProjectToGroupResult, ProjectGroupError>> {
  const subject = await subjectOf(projectId);
  if (!subject) return err(projectNotFound(projectId));
  const result = await projectGroupHost().bindToGroup(subject, chatId, expectedChatId);
  if (!result.success) return result;
  if (result.data.changed) {
    activitySignal({ event_id: randomUUID(), kind: 'project.group_bound', object_id: projectId,
      related_object_id: chatId, occurred_at: Date.now() });
    notifyProjectGroupBindingChanged(projectId);
  }
  return ok({ movedAgents: result.data.movedAgents, previousChatId: result.data.previousChatId });
}

/** 撤销并入:忘掉这个项目绑的群,agent 回到并入之前各自的群;已经加进去的 agent 留在那个群里。 */
export async function unbindProjectGroup(projectId: string): Promise<Result<void, ProjectGroupError>> {
  const subject = await subjectOf(projectId);
  if (!subject) return err(projectNotFound(projectId));
  const result = await projectGroupHost().unbind(subject);
  if (!result.success) return result;
  if (result.data.changed) {
    activitySignal({ event_id: randomUUID(), kind: 'project.group_unbound', object_id: projectId, occurred_at: Date.now() });
    notifyProjectGroupBindingChanged(projectId);
  }
  return ok();
}

/** MCP undo needs the state at unlink completion, before a different operation can acquire the lock. */
export async function unbindProjectGroupForAgent(projectId: string): Promise<Result<{ expectedChatId: string | null }, ProjectGroupError>> {
  const subject = await subjectOf(projectId);
  if (!subject) return err(projectNotFound(projectId));
  const result = await projectGroupHost().unbind(subject);
  if (!result.success) return result;
  if (result.data.changed) {
    activitySignal({ event_id: randomUUID(), kind: 'project.group_unbound', object_id: projectId, occurred_at: Date.now() });
    notifyProjectGroupBindingChanged(projectId);
  }
  if (result.data.expectedChatId === undefined) throw new Error('Project group host did not return the unlink checkpoint');
  return ok({ expectedChatId: result.data.expectedChatId });
}
