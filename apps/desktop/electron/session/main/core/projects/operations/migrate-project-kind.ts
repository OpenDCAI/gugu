import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '@main/db/client';
import { projects, workspaces } from '@main/db/schema';
import { isImplicitSessionHomeProjectId } from '@shared/core/projects/session-home-project';
import { isAppKeptDirectory, type AppKeptDirectories } from '../app-kept-directory';

function writeRecord(file: string, record: ProjectKindMigrationRecord): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, file);
}

export type ProjectKindMigrationRecord = { version: 1; demoted: { id: string; path: string; at: string }[] };

function readRecord(file: string): ProjectKindMigrationRecord {
  if (!existsSync(file)) return { version: 1, demoted: [] };
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as ProjectKindMigrationRecord;
  if (parsed?.version !== 1 || !Array.isArray(parsed.demoted)) throw new Error(`${file}: not a project-kind migration record`);
  return parsed;
}

/**
 * #609 / project-machine-model 迁移:库里已有的、登记在「咕咕自己要用的目录」(isAppKeptDirectory:~、task-home、GUGU_HOME
 * 底下)上的项目改成 workspace —— 从前 server 落主目录、App 派活、助理的家、导入 ~ 里的会话都建过这种项目。
 * 用户自己往里加过文件夹的不动(那是他在用的项目)。会话不挪:projectId 不变,它们因为项目成了 workspace 而列进「任务」。
 *
 * 幂等:只看 kind='project' 的行,判据是纯函数,重跑结果一样。可回滚:改了哪些行记在 `file` 里,
 * rollbackProjectKindMigration 按它改回 'project';比这一版旧的客户端本来就不认 kind。
 */
export function migrateProjectKind(file: string, dirs?: AppKeptDirectories): string[] {
  const candidates = db
    .select({ id: projects.id, path: projects.path })
    .from(projects)
    .where(and(eq(projects.kind, 'project'), eq(projects.workspaceProvider, 'local')))
    .all()
    .filter((row) => { try { return isImplicitSessionHomeProjectId(row.id) || isAppKeptDirectory(row.path, dirs); } catch { return false; } });
  if (candidates.length === 0) return [];
  const withUserFolders = new Set(
    db.select({ projectId: workspaces.projectId }).from(workspaces).where(isNotNull(workspaces.attachedAt)).all().map((row) => row.projectId),
  );
  const demote = candidates.filter((row) => !withUserFolders.has(row.id));
  if (demote.length === 0) return [];
  // 先记、后改:记录写不下去就不改,回滚永远知道改过哪些行。
  const record = readRecord(file);
  const at = new Date().toISOString();
  record.demoted.push(...demote.map((row) => ({ ...row, at })));
  writeRecord(file, record);
  db.transaction((tx) => {
    for (const row of demote) tx.update(projects).set({ kind: 'workspace' }).where(eq(projects.id, row.id)).run();
  });
  return demote.map((row) => row.id);
}

/** 回滚:把迁移改成 workspace 的行改回 'project'(不碰本来就是 workspace 的任务工作区),清空记录。 */
export function rollbackProjectKindMigration(file: string): string[] {
  const record = readRecord(file);
  const ids = record.demoted.map((row) => row.id);
  db.transaction((tx) => {
    for (const id of ids) tx.update(projects).set({ kind: 'project' }).where(eq(projects.id, id)).run();
  });
  writeRecord(file, { version: 1, demoted: [] });
  return ids;
}
