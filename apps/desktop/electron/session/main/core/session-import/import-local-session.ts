import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { resolveSessionPermissionMode } from '@gugu/session-core/acp';
import { createLocalProject } from '@main/core/projects/operations/create-local-project';
import { ensureRepositoryWorkspace } from '@main/core/projects/operations/ensure-repository-workspace';
import { getLocalProjectByPath } from '@main/core/projects/operations/getProjects';
import { openProject } from '@main/core/projects/operations/openProject';
import { sessionService } from '@main/core/sessions/session-service';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import {
  LOCAL_SESSION_ENGINE_PROVIDER,
  type ImportLocalSessionParams,
  type ImportLocalSessionResult,
  type LocalSessionEngine,
} from '@shared/core/session-import/session-import';
import { buildWorkspaceConfigFromPreset } from '@shared/core/workspaces/build-workspace-config-from-preset';
import { getLocalSessionSource } from './host-source';

// @@@sessionpage 导入本机已有会话 (spec session-page-import)。
//
// 「导入」不是把历史抄一份进来，而是把那条会话本身接进会话页：新建的 conversation 绑定
// provider 自己的 session id，第一次启动就走 resume，上下文仍在 provider 那边的原件里。
// 两个引擎的恢复机制不同，这里的 id 分配也就不同：
//   · claude 的 CLI 用会话页的 conversation.id 当会话号（`--resume <conversation.id>`），
//     所以 conversation.id 直接取原会话的 UUID；
//   · codex 声明了 `sessions.resumeNeedsProviderId`(续跑只认原生 id),用 conversation.sessionId
//     （`codex resume <sessionId>`），conversation.id 照常随机。
// 见 core/sessions/resolve-agent-session-command.ts。
//
// 会话跑在**原会话的工作目录**，不另开 worktree（repo-root preset）—— 换个目录 resume，
// 原会话里那些文件路径就全指错地方了。

/** claude 的 CLI 拿 conversation.id 当会话号，所以导入时直接用原会话 id 建 conversation。 */
function sessionIdFor(engine: LocalSessionEngine, providerSessionId: string): string {
  return engine === 'claude-code' ? providerSessionId : randomUUID();
}

/** 把项目创建失败的内部枚举翻成人话——用户看到「invalid-directory」等于没说。 */
function describeCreateProjectError(type: string, directory: string): string {
  switch (type) {
    case 'invalid-directory':
    case 'inspect-failed':
      return `这条会话所在的目录已经不在了或读不到：${directory}`;
    case 'not-repository':
      return `无法把 ${directory} 作为项目打开`;
    default:
      return `无法把 ${directory} 加成项目（${type}）`;
  }
}

/** 把 openProject 的失败翻成人话——「path-not-found」对用户等于没说。 */
function describeOpenProjectError(
  error: { type: string; message?: string },
  directory: string
): string {
  if (error.type === 'path-not-found') return `目录已经不在了：${directory}`;
  return error.message ? `${directory}（${error.message}）` : directory;
}

/**
 * 把项目挂载进 projectManager，并确认真的挂上了。
 *
 * 建任务查的是 projectManager 这个**内存注册表**，不是数据库 —— 库里有项目行 ≠ 能建任务。
 * 而挂载只发生在「新建项目」那条分支里，且那里 openProject 的返回值没人看；
 * 复用已存在项目的分支则根本不挂。两条路都会留下「库里有、注册表里没有」的项目，
 * 建任务时报成 project-not-found —— 一个指向错误方向的报错（项目明明在）。
 * 更糟的是重试：第二次会走「这个目录已经是项目了」的复用分支，同样不挂 → 永久失败。
 * 所以这里对**两条路**都显式挂一次并检查结果。
 */
async function mountImportProject<T extends { id: string; path: string }>(project: T): Promise<T> {
  const opened = await openProject(project.id);
  if (!opened.success) {
    throw new Error(
      `打不开这条会话所在的项目：${describeOpenProjectError(opened.error, project.path)}`
    );
  }
  return project;
}

/**
 * 找/建这条会话的落点项目。
 *
 * 关键是**会话必须在它原来的目录里跑起来**：claude 按「会话所在目录」定位会话
 * （`~/.claude/projects/<转义 cwd>`），归一化到仓库根会让 `--resume` 直接找不到原会话。
 * 所以只有当这个目录本身就是仓库根时才走常规建法（顺带拿到分支/更改能力）；
 * 其余情况（非 git 目录、或仓库的子目录）一律按原目录建，宁可少一点 git 能力，
 * 也不能把会话恢复到另一个目录里去。
 */
async function resolveImportProject(workingDirectory: string) {
  const existing = await getLocalProjectByPath(workingDirectory);
  if (existing) return await mountImportProject(existing);

  // 这个目录自己就是仓库根 → 照常建 git 项目（拿得到分支/更改这些能力）。
  // 否则（非 git 目录，或仓库的子目录）→ 就按这个目录本身建，不做仓库根归一化。
  const isRepositoryRoot = existsSync(join(workingDirectory, '.git'));
  const created = await createLocalProject({
    path: workingDirectory,
    name: basename(workingDirectory) || workingDirectory,
    allowNonGit: true,
    reuseExisting: true,
    exactPath: !isRepositoryRoot,
  });
  if (!created.success) {
    throw new Error(describeCreateProjectError(created.error.type, workingDirectory));
  }
  return await mountImportProject(created.data);
}

export async function importLocalSession(
  params: ImportLocalSessionParams
): Promise<ImportLocalSessionResult> {
  // 渲染层传来的 filePath 不可信，也可能来自上一轮缓存、文件早被删了。
  // 走宿主的解析器复核一遍：它同时把路径钉在允许的扫描目录内，并给出原件里的权威 sessionId/cwd。
  const preview = await getLocalSessionSource().preview({
    filePath: params.filePath,
    engine: params.engine,
  });

  const providerSessionId = preview.providerSessionId.trim();
  if (!providerSessionId) {
    throw new Error('这条会话没有可用的会话 id，无法恢复原会话');
  }
  const workingDirectory = preview.cwd?.trim();
  if (!workingDirectory) {
    throw new Error('读不出这条会话的工作目录，导入后无法在原位置继续');
  }

  const provider = LOCAL_SESSION_ENGINE_PROVIDER[params.engine];
  // 终端腿 `--resume`、聊天腿 `session/load`,续的都是同一个 provider 会话 id(见 switch-session-runtime)。
  const runtime = params.sessionView === 'general' ? 'acp' : 'pty';

  // 同一条会话只接进来一次：再次导入直接回到已有的那个会话，不建重复的。
  const [existing] = await db
    .select({
      id: sessions.id,
      projectId: sessions.projectId,
    })
    .from(sessions)
    .where(eq(sessions.providerSessionId, providerSessionId))
    .limit(1);
  if (existing) {
    return {
      projectId: existing.projectId,
      sessionId: existing.id,
      workingDirectory,
      alreadyImported: true,
    };
  }

  const project = await resolveImportProject(workingDirectory);

  const repositoryWorkspaceId = project.repositoryWorkspaceId ?? ensureRepositoryWorkspace(project);

  const sessionId = sessionIdFor(params.engine, providerSessionId);
  const title = preview.title.trim() || params.title.trim() || '导入的会话';

  const created = await sessionService.createSession({
    projectId: project.id,
    sessionConfig: {
      version: '1',
      name: title,
      initialSession: {
        id: sessionId,
        provider,
        title,
        // 导入是另一个动词:历史本来就在引擎那边，咕咕只是把它认领进来 ——
        // 带上 provider 自己的会话 id，第一次启动就 resume 它而不是开新的。
        origin: { kind: 'import', providerSessionId: providerSessionId },
        type: runtime,
        // 档位显式写进记录:缺席时终端腿会退回「不加旗标」= harness 自己挑档(#7366)。与新建缺省同一个答案。
        permissionMode: resolveSessionPermissionMode({}),
      },
    },
    workspaceConfig: buildWorkspaceConfigFromPreset('repo-root', { repositoryWorkspaceId }),
  });
  if (!created.success) {
    // ❌ 别在这里再写一次「导入失败：」——界面已经带了这个前缀，重复一遍只是噪音。
    throw new Error(`没能建出这条会话（${created.error.type}）`);
  }

  return {
    projectId: project.id,
    sessionId,
    workingDirectory: project.path,
    alreadyImported: false,
  };
}
