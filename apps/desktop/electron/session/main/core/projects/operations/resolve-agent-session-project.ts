import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { sessionHomeDir } from '@main/core/app/session-home-dir';
import { createLocalProject } from '@main/core/projects/operations/create-local-project';
import { getLocalProjectByPath, getProjectById } from '@main/core/projects/operations/getProjects';
import {
  IMPLICIT_SESSION_HOME_PROJECT_ID,
  IMPLICIT_SESSION_HOME_PROJECT_NAME,
} from '@shared/core/projects/session-home-project';

/**
 * 云端 `agent.create` 要一个项目落脚。从前只认「这个路径已经是项目」或「隐式任务工作区已经建好」,
 * 而隐式工作区只有渲染层在新建任务时才会建 —— 没有渲染层的咕咕 server(#6264)两样都没有,
 * 一台刚装好的服务器上建 agent 恒报 `has no project context`。
 *
 * 现在主进程自己补齐:
 *  - 给了目录:已是项目就用;目录存在但还没登记 → 当场登记(非 git 目录也行,就用这个目录本身,
 *    与导入本机会话同一口径);目录不存在 → 说清楚是哪个目录不存在。
 *  - 没给目录:用这台机器的隐式任务工作区,没有就建(与渲染层同一个 id、同一个名字、同一个目录)。咕咕 server 也一样
 *    (#609):❌ 再落到主目录($HOME)—— 那会把 ~ 登记成一个用户没建过的项目,侧栏里多出「~ · 机器」。
 *    任务工作区是 workspace,它的会话列在「任务」里。
 */
export async function resolveAgentSessionProject(requestedPath: string) {
  const path = requestedPath.trim();
  if (path) {
    const existing = await getLocalProjectByPath(path);
    if (existing) return existing;
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      throw new Error(`这台机器上没有目录 ${path},没法在那儿创建 agent`);
    }
    const created = await createLocalProject({
      path,
      name: basename(path) || path,
      allowNonGit: true,
      reuseExisting: true,
      exactPath: !existsSync(join(path, '.git')),
    });
    if (!created.success) {
      throw new Error(`登记项目 ${path} 失败:${created.error.type}`);
    }
    return created.data;
  }

  const implicit = await getProjectById(IMPLICIT_SESSION_HOME_PROJECT_ID);
  if (implicit) return implicit;
  const created = await createLocalProject({
    id: IMPLICIT_SESSION_HOME_PROJECT_ID,
    path: sessionHomeDir(),
    name: IMPLICIT_SESSION_HOME_PROJECT_NAME,
    createDirectory: true,
    allowNonGit: true,
    reuseExisting: true,
    exactPath: true,
  });
  if (!created.success) {
    throw new Error(`建任务工作区失败:${created.error.type}`);
  }
  return created.data;
}
