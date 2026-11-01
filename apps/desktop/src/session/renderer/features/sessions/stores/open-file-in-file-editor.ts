import { messageForUser } from '@/lib/userFacingError';
import { toast } from 'sonner';
import type { SessionPaneTab } from '@gugu/session-core/session-record/contract';
import { closeSessionPaneTab, sessionPaneTabs } from './session-pane-tabs';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { when } from 'mobx';
import {
  asProvisioned,
  getSessionPageStore,
  getSessionView,
} from '@renderer/features/sessions/stores/session-selectors';
import { sessionPaneReady } from '../session-pane-ready';
import { rpc } from '@renderer/lib/ipc';
import type { OpenedOutput } from '@gugu/session-chat-ui/opened-outputs';
import { rendererLogger } from '../../../../../lib/log';
import { isAbsolutePath, isPathInsideWorkspace, resolveWorkspacePath } from './workspace-path';
import { workspaceRegistry } from './workspace-registry';
import type { WorkspaceViewModel } from '@renderer/features/sessions/stores/workspace-view-model';
import { pickSessionOpener } from '@renderer/features/extensions/open-with';
import { attachmentOpenTarget } from './attachment-open-target';
import { workspaceRpc } from '@renderer/features/sessions/workspace-backend/workspace-backend';
import type { BrowserTabResource } from '@renderer/features/browser/browser-tab-resource';
import type { FilePlace } from '@gugu/core/shared/ui/guguLink';

const sessionLog = rendererLogger('gugu-session');

function resolveEditorFilePath(workspacePath: string, filePath: string): string | null {
  const resolvedPath = resolveWorkspacePath(workspacePath, filePath);
  if (isAbsolutePath(filePath) && !isPathInsideWorkspace(workspacePath, resolvedPath)) {
    return null;
  }
  return resolvedPath;
}

/** Cached `rpc.app.getHomeDirectory()` —— home 在会话内不变,一次 RPC 终身复用。 */
let homeDirectoryPromise: Promise<string> | null = null;
function fetchHomeDirectory(): Promise<string> {
  homeDirectoryPromise ??= rpc.app.getHomeDirectory();
  return homeDirectoryPromise;
}

/**
 * `~/x` → 家目录下的绝对路径,语义与主进程 `expandAbsoluteOrTildePath` 同一条(只认 `~/` 前缀)。
 * 不展开的话 `~` 会被当工作区相对路径拼成 `<ws>/~/…`,报一条指向不存在位置的误导 toast。
 * 取不到 home 是环境故障:记日志后原样返回,让后续的存在性检查自己 fail loud,❌ 不在这里猜。
 */
async function expandHomeTildePath(filePath: string): Promise<string> {
  if (!filePath.startsWith('~/')) return filePath;
  try {
    const home = (await fetchHomeDirectory()).replace(/[\\/]+$/, '');
    return `${home}/${filePath.slice(2)}`;
  } catch (error: unknown) {
    // 一次瞬时的 RPC 失败(桥没就绪等)不能污染整个会话 —— 释放缓存,下次点击重试,
    // ❌ 把 rejected promise 记一辈子,那 `~/` 就永久退回误导 toast。
    homeDirectoryPromise = null;
    sessionLog.warn({ err: String(error), filePath }, 'getHomeDirectory failed; keeping ~ path');
    return filePath;
  }
}

/**
 * 交给系统(openPath)并把失败变成用户看得见的 toast,❌ 不静默吞。
 * 文件页签里「用系统默认程序打开」也走这一条(#7191)。
 */
/**
 * `workspace`:文件在这个工作区里时带上 —— 主进程据此也放行 home 外的工作区(外接盘、/opt…,#7191)。
 * 不带就只认 home 里的路径。
 */
export async function openPathWithFailureToast(
  filePath: string,
  workspace?: { projectId: string; workspaceId: string }
): Promise<void> {
  const result = await rpc.app.openPath(filePath, workspace);
  if (!result.success) {
    sessionLog.error({ err: result.error, filePath }, 'openPath failed');
    toast.error(translateSessionMessage('taskError.openFileFailed', { path: '[path]' }), { description: messageForUser(result.error) });
  }
}

/**
 * 目录交给系统文件管理器 —— 与标题栏「打开方式」同一条 `openIn(finder)` 路:
 * 它不带 home jail(`rpc.app.openPath` 有,home 外的工作区目录会被拒)。
 */
async function openDirectoryInFileManager(dirPath: string): Promise<void> {
  const result = await rpc.app.openIn({ app: 'finder', path: dirPath });
  if (!result?.success) {
    sessionLog.error({ err: result?.error, dirPath }, 'openIn(finder) failed');
    toast.error(translateSessionMessage('taskError.openFileFailed', { path: '[path]' }), { description: messageForUser(result?.error) });
  }
}

/** `beside`:开在对话右边并排(spec session-page「并排」)—— agent 打开的、从对话里点开的走这条。 */
type FileOpenTarget = 'active' | 'beside';

/**
 * Open a resolved, in-working-copy file in the pane — deciding WHAT opens it.
 *
 * 「用什么打开这个文件」是解析层的事,不归任何一个入口。人点开一个 `.csv` 和 agent 用
 * `open_in_tab` 打开同一个 `.csv`,穿过的必须是这一个函数 —— ❌ 别在调用方各写一遍判断:
 * 两份判断今天一致,改一边就分岔,于是同一个产品对同一个文件给出两个答案。
 *
 * An extension that claimed this file type opens it instead of the built-in editor
 * (behavior tab-extensions:「认领某类文件的打开方式」). One claim opens straight away; when
 * several claim it the person picks in 「用哪个打开」 — once, if they tick 「始终用它」
 * (真源 §2.4, 主人 09-29; open-with.ts). The built-in editor is always one of the answers.
 *
 * The built-in editor stays reachable: the claimed tab carries a host-provided
 *「改用内置编辑器打开」 entry (extension-tab-provider.tsx). Without that escape hatch,
 * installing an extension could make a file type unopenable — an ability no install
 * may have.
 *
 * Resolves to the extension tab kind that took the file, null when the built-in editor did,
 * or undefined when the person cancelled 「用哪个打开」 — the caller reports that outcome
 * rather than predicting it.
 */
async function openResolvedFileInPane(
  viewModel: WorkspaceViewModel,
  resolvedPath: string,
  options: { preview: boolean; beside?: boolean; activate?: boolean; ask?: boolean; place?: { sessionId: string; at: FilePlace } }
): Promise<string | null | undefined> {
  const opener = await pickSessionOpener(resolvedPath, options.ask === true);
  if ('cancelled' in opener) return undefined;
  const claim = 'tabKind' in opener ? opener : null;
  // A link's place (`path#k=v&…`): the App that opens it is told, as a chat file's pill tells its App — before the tab
  // opens, so a page still opening finds it waiting. The built-in editor takes no place. Only plain ids cross: the
  // candidate holds the App's manifest.
  if (claim?.candidate && options.place) {
    const { extensionId, tabKind } = claim.candidate;
    const told = await rpc.extensions.sessionFilePlace({ sessionId: options.place.sessionId, filePath: resolvedPath, extensionId, tabKind, at: { ...options.place.at } });
    if (!told.success) throw new Error(`The place in ${resolvedPath} could not be handed to the App that opens it: ${told.error}`);
  }
  const config = options.beside
    ? { preview: options.preview, beside: true, ...(options.activate === false ? { activate: false } : {}) }
    : { preview: options.preview };

  if (claim) {
    // Through `paneLayout`, not `activePane`: an extension tab kind is a runtime
    // string (`<id>.<tab>`), which is exactly what the pane layout takes and what
    // the「+ 添加面板」menu already uses to open one. `activePane.open` is typed to
    // the built-in kinds and cannot name one.
    viewModel.paneLayout.open(claim.tabKind, { filePath: resolvedPath }, config);
    return claim.tabKind;
  }

  if (options.beside) {
    viewModel.paneLayout.open('file', { path: resolvedPath }, config);
  } else {
    viewModel.activePane.open('file', { path: resolvedPath }, { preview: options.preview });
  }
  return null;
}

async function openSessionFile(
  projectId: string,
  sessionId: string,
  rawFilePath: string,
  target: FileOpenTarget,
  at?: FilePlace,
  ask = false
): Promise<void> {
  const provisioned = asProvisioned(getSessionPageStore(projectId, sessionId));
  if (!provisioned) throw new Error('This session has no prepared workspace');
  const workspace = workspaceRegistry.get(projectId, provisioned.workspaceId);
  if (!workspace) throw new Error('This session has no workspace');
  const filePath = await expandHomeTildePath(rawFilePath);
  const resolvedPath = resolveEditorFilePath(workspace.path, filePath);
  if (resolvedPath === null) {
    await openExternalFilePath(projectId, sessionId, filePath, { beside: target === 'beside' });
    return;
  }

  // Agent output often points at paths that don't exist in the worktree
  // (subdirectory-relative, deleted, etc.) — precheck so we can toast a
  // useful error instead of opening an empty tab.
  const exists = await workspaceRpc(projectId).files.fileExists(
    projectId,
    provisioned.workspaceId,
    resolvedPath
  );
  if (!exists.success || !exists.data.exists) {
    throw new Error(translateSessionMessage('taskError.fileNotFound', { path: filePath }));
  }
  // 目录交给系统文件管理器开它自己的窗口 —— 塞进编辑器只会开出永远 Loading 的页签。
  if (exists.data.isDirectory) {
    await openDirectoryInFileManager(resolvedPath);
    return;
  }

  const viewModel = provisioned.viewModel;
  if (!viewModel) throw new Error('This session has no prepared pane');

  const opened = await openResolvedFileInPane(viewModel, resolvedPath, {
    preview: false,
    beside: target === 'beside',
    ...(at ? { place: { sessionId, at } } : {}),
    ...(ask ? { ask } : {}),
  });
  if (opened === undefined) throw new Error('The person did not pick an App to open it with');
}

/**
 * Opens a file in the BUILT-IN editor, ignoring any extension's claim on its type.
 *
 * The escape hatch behind「认领某类文件的打开方式」. It exists so that honouring a
 * claim can never make a file type unopenable: whatever an install contributes,
 * this route still reaches the editor. ❌ 不要改成走 openFileInSessionEditor —— 那条会
 * 再次问一遍认领,于是「改用内置编辑器打开」又回到扩展 tab,原地打转。
 */
export function openFileInBuiltInEditor(
  projectId: string,
  sessionId: string,
  resolvedPath: string
): void {
  const provisioned = asProvisioned(getSessionPageStore(projectId, sessionId));
  const viewModel = provisioned?.viewModel ?? getSessionView(projectId, sessionId);
  if (!viewModel) return;
  viewModel.activePane.open('file', { path: resolvedPath }, { preview: false });
}

export async function openFileInSessionEditor(
  projectId: string,
  sessionId: string,
  filePath: string,
  opts?: { beside?: boolean; at?: FilePlace; ask?: boolean }
): Promise<void> {
  await openSessionFile(projectId, sessionId, filePath, opts?.beside ? 'beside' : 'active', opts?.at, opts?.ask === true);
}

/**
 * 开在对话右边并排(spec session-page「并排」)。聊天里改动卡片上的文件名走这条 —— 原先它在右边另分一格、
 * 多出第二条页签条,正是 owner 说的「一个会话没必要两个 tabs」。
 */
export async function openFileBesideConversation(
  projectId: string,
  sessionId: string,
  filePath: string
): Promise<void> {
  await openSessionFile(projectId, sessionId, filePath, 'beside');
}

export async function openExternalFilePath(
  projectId: string,
  sessionId: string,
  rawFilePath: string,
  opts?: { beside?: boolean }
): Promise<void> {
  // 消息里那条 mention 指着**用户自己那个文件**(agent 要改的就是它),但点开不能跟着走它:
  // 原路径依赖「文件还在不在」与「在不在 home 里」,而 home 之外 `openPath` 直接判死 ——
  // 那正是 #5269 最初那个「打不开」。我们自己留了副本就打开副本;工作区文件查不到副本,
  // 照旧原路径打开(那是对的:用户就是要打开工作区里那个文件)。
  const resolved = await rpc.sessionCreate.resolveAttachmentPath(sessionId, rawFilePath).catch(() => null);
  // `~/` 展开在这条路同样要做:终端链接检测把 `~/` 前缀标成 external 走到这儿,
  // 不展开的话会拿字面 `~` 开外部页签,而 readExternalFile 只收绝对路径 —— 必然坏页签。
  // (副本命中时 resolved.data 已是绝对真实路径,展开是 no-op。)
  const filePath = await expandHomeTildePath(resolved?.success ? resolved.data : rawFilePath);
  const provisioned = asProvisioned(getSessionPageStore(projectId, sessionId));
  // 工作区外的绝对路径先问一句「它是什么」:缺失 → 明确 toast(❌ 不是开出永远 Loading 的
  // 外部 tab);目录 → 系统文件管理器开它本身。stat 不可用(工作区已不在等)按原路由走,
  // ❌ 不因此静默吞掉点开动作。
  if (isAbsolutePath(filePath) && provisioned?.workspaceId) {
    const stat = await rpc.workspace.files
      .statExternalFile(projectId, provisioned.workspaceId, filePath)
      .catch(() => null);
    if (stat?.success) {
      if (!stat.data.exists) {
        toast.error(translateSessionMessage('taskError.fileNotFound', { path: filePath }));
        return;
      }
      if (stat.data.isDirectory) {
        await openDirectoryInFileManager(filePath);
        return;
      }
    }
  }
  // owner 2026-09-10:「文件我点击可以是 tab 打开吧」——默认开在会话页的一个 tab 里,
  // 画不出来的那几种才交给系统(见 `attachmentOpenTarget`)。
  const target = attachmentOpenTarget(filePath);
  if (target !== 'system') {
    const viewModel = provisioned?.viewModel ?? getSessionView(projectId, sessionId);
    // 没有可用的面板就退到系统默认程序 —— ❌ 不许在这里静默 return。
    // 「未选择项目」建出来的任务没有工作区面板,而它照样附得了文件(#5269)。
    if (viewModel) {
      if (opts?.beside) viewModel.paneLayout.open('file', { path: filePath, external: true }, { preview: false, beside: true });
      else viewModel.activePane.open('file', { path: filePath, external: true }, { preview: false });
      return;
    }
  }
  await openPathWithFailureToast(filePath);
}

/**
 * 点了对话里的一张附件卡(#7193):agent 用 open_in_tab 打开过的那份文件 / 网页,重开在对话右边。
 * 与对话顶部「输出」里点那一条是同一个动作(`reopenOutput`),❌ 另写一条打开路。
 */
export function reopenSessionOutput(projectId: string, sessionId: string, output: OpenedOutput): void {
  const provisioned = asProvisioned(getSessionPageStore(projectId, sessionId));
  const viewModel = provisioned?.viewModel ?? getSessionView(projectId, sessionId);
  if (!viewModel) {
    // 卡片画在这条会话的对话里,对话挂着它的面板就在;走到这里说明对不上,如实记下。
    sessionLog.warn({ projectId, sessionId }, 'opened-output card clicked without a session view');
    return;
  }
  viewModel.reopenOutput(output);
}

/**
 * 文本里的文件链接点开。`beside`:链接在对话里(聊天、编程模式的对话终端)= 开在对话右边(spec session-page「并排」);
 * 普通终端页签里的链接照旧开成页签。
 */
export function makeFileLinkHandlers(
  projectId: string,
  sessionId: string,
  opts?: { beside?: boolean }
): { onOpenFile: (filePath: string, at?: FilePlace) => void; onOpenExternal: (filePath: string) => void } {
  return {
    onOpenFile: (filePath, at) => {
      // A click on a link: what fails is said with the same toast an open that fails says, not left in the console.
      openFileInSessionEditor(projectId, sessionId, filePath, { ...opts, ...(at ? { at } : {}) }).catch((error: unknown) => {
        sessionLog.error({ err: String(error), filePath }, 'opening a linked file failed');
        toast.error(translateSessionMessage('taskError.openFileFailed', { path: '[path]' }), { description: messageForUser(error) });
      });
    },
    onOpenExternal: (filePath) => {
      void openExternalFilePath(projectId, sessionId, filePath, opts);
    },
  };
}

export function manageSessionTabsWhenReady(request: {
  projectId: string; sessionId: string; tabId?: string;
  onResult: (result: { success: boolean; tabs?: SessionPaneTab[]; closed?: boolean; error?: string }) => void;
}): () => void {
  return when(sessionPaneReady(request.projectId, request.sessionId), () => {
    const view = asProvisioned(getSessionPageStore(request.projectId, request.sessionId))?.viewModel;
    if (!view) { request.onResult({ success: false, error: 'target session pane is unavailable' }); return; }
    void (async () => {
      try {
        const result = request.tabId === undefined
          ? { tabs: sessionPaneTabs(view.paneLayout) }
          : await closeSessionPaneTab(view.paneLayout, request.tabId);
        request.onResult({ success: true, ...result });
      } catch (error) {
        request.onResult({ success: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
  }, { timeout: 10_000, onError: (error) => request.onResult({ success: false, error: String(error) }) });
}

export function openHostRequestedFileInSessionWhenReady({
  projectId,
  sessionId,
  path,
  external,
  intent,
  tabKind,
  ask,
  onResult,
  timeout = 10_000,
}: {
  projectId: string;
  sessionId: string;
  path: string;
  external: boolean;
  intent: 'preview' | 'pinned';
  tabKind?: string;
  /** Everyone who opens it, the person picks (an App's `files.openWith(file, { ask: true })`). */
  ask?: boolean;
  onResult: (result: { success: boolean; error?: string; openedWith?: string | null }) => void;
  timeout?: number;
}): () => void {
  return when(
    sessionPaneReady(projectId, sessionId),
    () => {
      const session = asProvisioned(getSessionPageStore(projectId, sessionId));
      try {
        if (!session?.viewModel) throw new Error('target session pane is unavailable');
        // Same resolver the click path uses — that is the whole point: the file does
        // not land in a different tab depending on who asked for it. An outside path
        // is a read-only external file and consults nobody, which is also where the
        // click path draws the line.
        // 宿主替 agent(或 App)打开的:开在对话右边并排,❌ 盖住对话;用户正看着别的也 ❌ 切走(spec gugu-plugin「在工作区打开文件」)。
        if (external) {
          session.viewModel.paneLayout.open(
            'file',
            { path, external: true },
            { preview: intent === 'preview', beside: true, activate: false },
          );
          onResult({ success: true, openedWith: null });
        } else if (tabKind) {
          // 摩擦单 F122 «Open with X», named by the caller (main checked X claims it): what「用哪个打开」does once picked.
          session.viewModel.paneLayout.open(tabKind, { filePath: path }, { preview: intent === 'preview', beside: true, activate: false });
          onResult({ success: true, openedWith: tabKind });
        } else {
          // Reported, not predicted: the host says what actually opened because the
          // renderer is the one that opened it — after the person picked, when they had to.
          void openResolvedFileInPane(session.viewModel, path, {
            preview: intent === 'preview',
            beside: true,
            activate: false,
            ...(ask ? { ask } : {}),
          }).then(
            (openedWith) =>
              onResult(
                openedWith === undefined
                  ? { success: false, error: 'The person did not pick an App to open it with' }
                  : { success: true, openedWith }
              ),
            (error: unknown) => onResult({ success: false, error: error instanceof Error ? error.message : String(error) })
          );
        }
      } catch (error) {
        onResult({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    {
      timeout,
      onError: (error) => {
        console.error('[gugu-session] Timed out opening a host-validated file', {
          projectId,
          sessionId,
          path,
          error,
        });
        onResult({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    },
  );
}

/** Opens a host-validated HTTP(S) URL in the owning task without changing routes. */
export function openHostRequestedExtensionInSessionWhenReady({
  projectId,
  sessionId,
  tabKind,
  intent,
  reveal = false,
  tabId,
  ifAbsent = false,
  onResult,
  timeout = 10_000,
}: {
  projectId: string;
  sessionId: string;
  tabKind: string;
  intent: 'preview' | 'pinned';
  reveal?: boolean;
  tabId?: string;
  ifAbsent?: boolean;
  onResult: (result: { success: boolean; error?: string }) => void;
  timeout?: number;
}): () => void {
  return when(
    sessionPaneReady(projectId, sessionId),
    () => {
      void (async () => {
        const session = asProvisioned(getSessionPageStore(projectId, sessionId));
        try {
          if (!session?.viewModel) throw new Error('target session pane is unavailable');
          // 刚装上的扩展,渲染层得先登记过它的页签,`kind` 才认得出来。设置页那条路装完自己
          // 会补一次登记(ExtensionsSettingsCard),而 agent 那条路整个装在主进程里,渲染层
          // 压根没听说过这次安装 —— 不补这一下,「装上、马上打开」必然打不开。补登记是幂等的。
          if (!session.viewModel.activePane.registry.has(tabKind)) {
            // 动态 import:登记模块要拉进整套扩展页签 UI,而这条补登记是**少见分支**(只有
            // 「刚装上、马上打开」才会走)。静态引它等于让每个 import 这个 store 的地方都背上
            // 那棵子树 —— 实测会把它拖进单测的模块图,在 telemetry 的模块级副作用上炸掉。
            const { registerInstalledExtensionTabs } = await import(
              '@renderer/features/extensions/register-extension-tabs'
            );
            await registerInstalledExtensionTabs();
          }
          // ❌ 不许在这里回 success:`paneLayout.open` 对不认识的 kind 只 console.warn 然后
          // 返回,不抛 —— 照原样往下走,宿主会收到一句「开好了」,而屏幕上什么都没有。
          if (!session.viewModel.activePane.registry.has(tabKind)) {
            throw new Error(`"${tabKind}" is not a tab kind this window knows about`);
          }
          // #7317 宿主自己替任务开的(第一次用 Computer Use):这个任务里已经有一枚,在哪都不动它。
          if (ifAbsent && session.viewModel.paneLayout.groups.some((group) => [...group.pane.entries.values()].some((entry) => entry.kind === tabKind))) {
            onResult({ success: true });
            return;
          }
          if (reveal) {
            // #6387 一个链接 / 一次横幅点击 = 「把那个扩展给我看」,❌ 每点一次叠一个新 tab。
            // 这个任务里已经开着同一类的,切过去即可;没有才新开。
            // 点名了哪一格(横幅是那一格发的)且它还开着,就是它;否则取同类的第一个。
            const layout = session.viewModel.paneLayout;
            const candidates = layout.groups.flatMap((group) =>
              [...group.pane.entries.values()]
                .filter((entry) => entry.kind === tabKind)
                .map((entry) => ({ group, entry }))
            );
            const found =
              candidates.find(({ entry }) => entry.tabId === tabId) ?? candidates[0];
            if (found) {
              layout.setActiveGroup(found.group.paneId);
              found.group.pane.setActiveTab(found.entry.tabId);
              onResult({ success: true });
              return;
            }
          }
          // Through `paneLayout`, not `activePane`: an extension tab kind is a runtime
          // string (`<id>.<tab>`), which is what the pane layout takes and what the
          // 「+ 添加面板」menu already uses. `activePane.open` is typed to the built-in
          // kinds and cannot name one. It lands beside the conversation, the same place a file
          // or a page lands (spec gugu-plugin「在工作区打开文件」:`app_tab` 同样开在对话右边).
          session.viewModel.paneLayout.open(
            tabKind,
            {},
            // `reveal` = 人点的(横幅、gugu://ext 链接):要看它,亮出来;agent 请上屏的不切走用户正看着的。
            { preview: intent === 'preview', beside: true, activate: reveal },
          );
          onResult({ success: true });
        } catch (error) {
          onResult({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    },
    {
      timeout,
      onError: (error) => {
        sessionLog.error({
          projectId,
          sessionId,
          tabKind,
          error,
        }, 'Timed out opening a host-validated extension tab');
        onResult({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    },
  );
}

export function openHostRequestedBrowserInSessionWhenReady({
  projectId,
  sessionId,
  url,
  intent,
  onResult,
  timeout = 10_000,
  acquire,
}: {
  projectId: string;
  sessionId: string;
  url: string;
  intent: 'preview' | 'pinned';
  onResult: (result: { success: boolean; error?: string; browserId?: string; created?: boolean }) => void;
  timeout?: number;
  acquire?: { browserId?: string; createIfMissing: boolean; deadline: number };
}): () => void {
  const lifetime = new AbortController();
  const dispose = when(
    sessionPaneReady(projectId, sessionId),
    () => {
      const session = asProvisioned(getSessionPageStore(projectId, sessionId));
      try {
        if (!session?.viewModel) throw new Error('target session pane is unavailable');
        if (acquire) {
          void acquireBrowserPage(session.viewModel, url, acquire, lifetime.signal).then(
            (page) => onResult({ success: true, ...page }),
            (error: unknown) => onResult({ success: false, error: error instanceof Error ? error.message : String(error) }),
          );
          return;
        }
        session.viewModel.showPage(url, { preview: intent === 'preview', reload: true, beside: true, activate: false });
        onResult({ success: true });
      } catch (error) {
        onResult({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    {
      timeout,
      onError: (error) => {
        sessionLog.error({
          projectId,
          sessionId,
          url,
          error,
        }, 'Timed out opening a host-validated browser URL');
        onResult({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    },
  );
  return () => { lifetime.abort(); dispose(); };
}

/** Restore the tab's identity and partition, even when its React surface has left the recent-page pool. */
async function acquireBrowserPage(
  view: WorkspaceViewModel,
  url: string,
  request: { browserId?: string; createIfMissing: boolean; deadline: number },
  signal: AbortSignal,
): Promise<{ browserId: string; created: boolean }> {
  const checkDeadline = () => {
    signal.throwIfAborted();
    if (Date.now() >= request.deadline) throw new Error('timed out restoring the session browser page');
  };
  const tabs = () => [...view.paneLayout.groups, ...[...view.paneLayout.windowPanes.values()].map((w) => ({ pane: w.pane }))]
    .flatMap(({ pane }) => pane.resolvedTabs.filter((tab) => tab.kind === 'browser').map((tab) => ({ pane, tab })));
  checkDeadline();
  const existing = tabs();
  let chosen = existing.find(({ tab }) => (tab.resource as BrowserTabResource).browserId === request.browserId)
    ?? existing.find(({ tab }) => tab.isFocused)
    ?? existing.find(({ tab }) => tab.isActive)
    ?? existing[0];
  const created = !chosen;
  if (!chosen) {
    if (!request.createIfMissing) throw new Error('This session has no browser tab. Use browser_navigate with a URL first.');
    view.showPage(url, { preview: false, reload: false, beside: true, activate: false });
    chosen = tabs()[0];
  }
  if (!chosen) throw new Error('the session pane could not create a browser tab');
  const closeCreated = () => { if (created) chosen.pane.closeTab(chosen.tab.tabId); };
  signal.addEventListener('abort', closeCreated, { once: true });
  const timer = setTimeout(closeCreated, Math.max(0, request.deadline - Date.now()));
  try {
    const snapshot = (chosen.tab.resource as BrowserTabResource).session;
    if (!snapshot) throw new Error('the browser tab has no saved page to restore');
    const registered = await rpc.browser.registerSession({ browserId: snapshot.browserId, partition: snapshot.partition, sessionId: snapshot.sessionId });
    checkDeadline();
    if (!registered.success) throw new Error(registered.error);
    const page = await rpc.browser.ensureAgentPage({ browserId: snapshot.browserId, partition: snapshot.partition, url: snapshot.currentUrl });
    checkDeadline();
    if (!page.success) throw new Error(`could not restore the browser page: ${page.error}`);
    return { browserId: snapshot.browserId, created };
  } catch (error) {
    // Only a tab created by this failed acquisition is rolled back; existing tabs and their login stay intact.
    closeCreated();
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', closeCreated);
  }
}
