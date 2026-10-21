import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
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
 *  - 没给目录:
 *    · 无界面的咕咕 server(server 模式):落在这台机器的主目录项目($HOME,已有同路径项目就复用,否则登记)。
 *      server 上的会话永远是从别的机器看的,而别的机器上的会话一律属于那台机器上的某个项目
 *      (behavior gugu-server「会话页里的别的机器」,owner 2026-09-25)——与桌面在那台机器上新建时落的是同一个项目。
 *    · 桌面机:用隐式任务工作区,没有就建(与渲染层同一个 id、同一个名字、同一个目录);它在本机侧栏的「任务」列表里。
 */
export async function resolveAgentSessionProject(
  requestedPath: string,
  host: { serverMode: boolean; homeDir: () => string } = {
    serverMode: process.env.GUGU_SERVER_MODE === '1',
    homeDir: homedir,
  },
) {
  const path = requestedPath.trim() || (host.serverMode ? host.homeDir() : '');
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
