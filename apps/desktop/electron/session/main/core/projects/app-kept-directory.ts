import { homedir } from 'node:os';
import path from 'node:path';
import { resolveGuguHome } from '@gugu/core/local/state/paths';
import { projectPathKey } from './path-utils';

/** taskHome: 任务工作区本身靠固定 id 认(isImplicitSessionHomeProjectId),这里只在调用方给了时才看它。 */
export type AppKeptDirectories = { home: string; guguHome: string; taskHome?: string };

function currentDirectories(): AppKeptDirectories {
  return { home: homedir(), guguHome: resolveGuguHome() };
}

const inside = (child: string, parent: string) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
};

/**
 * #609 一个目录是不是「咕咕自己要用的」:这台机器的主目录(~),GUGU_HOME 底下(助理的家与工作目录都在那里);
 * 任务工作区(task-home)按固定 id 认。在这些目录里登记的项目是 workspace —— 不进任何项目列表、选择器、计数与账号项目表,会话列在「任务」里。
 * ❌ 不看是谁建的:agent.create、App 派活、导入本机会话、别的机器打进来的建项目,都按这同一个判据落 kind。
 */
export function isAppKeptDirectory(directory: string, dirs: AppKeptDirectories = currentDirectories()): boolean {
  const key = projectPathKey(directory);
  return key === projectPathKey(dirs.home) || inside(key, projectPathKey(dirs.guguHome))
    || (!!dirs.taskHome && inside(key, projectPathKey(dirs.taskHome)));
}
