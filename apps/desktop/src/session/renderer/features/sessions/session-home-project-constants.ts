/**
 * Internal project used only as the execution context for a task created before
 * the user chooses (or opens) a repository. It must never be rendered as a
 * selectable project.
 */
export const IMPLICIT_SESSION_HOME_PROJECT_ID = '00000000-0000-4000-8000-000000000001';
export { IMPLICIT_SESSION_HOME_PROJECT_NAME } from '@shared/core/projects/session-home-project';

/** 本机的,或别的机器上那一份(在这边换过名:`<固定 id>~<机器>`,见 lib/machine-routing.ts)。 */
export function isImplicitSessionHomeProject(project: { id: string }): boolean {
  return project.id === IMPLICIT_SESSION_HOME_PROJECT_ID || project.id.startsWith(`${IMPLICIT_SESSION_HOME_PROJECT_ID}~`);
}

/**
 * #609 唯一的「是不是项目」判据:workspace(任务工作区、~、助理与 App 的目录,主机按目录记在 `kind` 上)不是项目 ——
 * 不进项目列表、选择器与计数,会话列在「任务」里。比 `kind` 更早的主机只认得出固定 id 的任务工作区。
 */
export function isWorkspaceProject(project: { id: string; data?: { kind?: string } | null }): boolean {
  return isImplicitSessionHomeProject(project) || project.data?.kind === 'workspace';
}
