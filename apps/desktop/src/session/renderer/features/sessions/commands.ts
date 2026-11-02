import { browserControlsRegistry } from '@renderer/features/browser/browser-controls-registry';
import { sessionKeyboardNav } from '@renderer/features/sidebar/session-keyboard-nav';
import type { BrowserTabResource } from '@renderer/features/browser/browser-tab-resource';
import { requestArchiveSession } from '@renderer/features/sessions/archive-session-flow';
import { focusedSessionId } from '@renderer/features/sessions/pane-selectors';
import { getGitRepositoryStore } from '@renderer/features/projects/stores/project-selectors';
import type { ResolvedTab } from '@renderer/features/tabs/core/tab-provider';
import {
  getRegisteredSessionData,
  getSessionGitWorktreeStore,
  getSessionPageStore,
  getSessionView,
} from '@renderer/features/sessions/stores/session-selectors';
import type { CommandProvider } from '@renderer/lib/commands/types';
import { copyExternalLink } from '@renderer/lib/open-external-link';
import { rpc } from '@renderer/lib/ipc';
import { normalizeBrowserUrl } from '@shared/browser';
import { COMMANDS, type CommandId } from '@shared/commands';
import { runGitFetch, runGitPublishBranch, runGitPull, runGitPush } from './git-action-handlers';
import { WORKSPACE_APP_KIND } from '@renderer/features/chats/chat-tabs/chat-panel-item';
import { startSideSession } from './start-side-session';
import { terminalEnabledSnapshot } from '@renderer/features/settings/use-terminal-enabled';

function sessionDef<T extends CommandId>(id: T): (typeof COMMANDS)[T] {
  return COMMANDS[id];
}

/**
 * Returns a CommandProvider for the task scope.
 *
 * getCommands() reads MobX observables so the command registry's
 * @computed activeCommands reacts to state changes automatically.
 */
export function createSessionCommandProvider(projectId: string, sessionId: string): CommandProvider {
  return {
    scopeId: 'session',

    getCommands() {
      const sessionPageStore = getSessionPageStore(projectId, sessionId);
      /** 归档那一格点名的对象 = 当前打开的那条会话;enabled 与 execute 必须读同一处。 */
      const archiveTargetSessionId = (): string | undefined => {
        const focusedPane = getSessionView(projectId, sessionId)?.paneLayout.focusedPane;
        return focusedPane ? focusedSessionId(focusedPane) : undefined;
      };

      // Guard: only expose commands when the task is fully provisioned.
      if (sessionPageStore?.state !== 'provisioned') return [];

      const sessionView = getSessionView(projectId, sessionId);
      const activePane = sessionView?.activePane;

      const git = getSessionGitWorktreeStore(projectId, sessionId);
      const repository = git ? getGitRepositoryStore(projectId) : undefined;
      const sessionData = getRegisteredSessionData(projectId, sessionId);
      // 两个网页并排(spec session-page「并排」):后退、刷新落在点着的那一边,❌ 总是左边那个。
      const shownBrowserTabs = activePane?.resolvedTabs.filter((tab) => tab.isActive && tab.kind === 'browser') ?? [];
      const activeBrowserTab = (shownBrowserTabs.find((tab) => tab.isFocused) ?? shownBrowserTabs[0]) as
        | ResolvedTab<BrowserTabResource>
        | undefined;
      const activeBrowserResource = activeBrowserTab?.resource as BrowserTabResource | undefined;
      const activeBrowserSession = activeBrowserResource?.session ?? null;

      const sideSessionDef = sessionDef('session.sideSession');
      const sidebarChangesDef = sessionDef('session.sidebarChanges');
      const sidebarFilesDef = sessionDef('session.sidebarFiles');
      const viewTerminalsDef = sessionDef('session.viewTerminals');
      const newTerminalDef = sessionDef('session.newTerminal');
      const openBrowserDef = sessionDef('session.openBrowser');
      const browserGoBackDef = sessionDef('session.browserGoBack');
      const browserGoForwardDef = sessionDef('session.browserGoForward');
      const browserReloadDef = sessionDef('session.browserReload');
      const browserFocusUrlDef = sessionDef('session.browserFocusUrl');
      const browserOpenExternalDef = sessionDef('session.browserOpenExternal');
      const browserCopyUrlDef = sessionDef('session.browserCopyUrl');
      const gitFetchDef = sessionDef('session.gitFetch');
      const gitPullDef = sessionDef('session.gitPull');
      const gitPushDef = sessionDef('session.gitPush');
      const pinDef = sessionDef('task.pin');
      const archiveDef = sessionDef('task.archive');
      const focusSidebarDef = sessionDef('session.focusSidebar');
      const focusComposerDef = sessionDef('session.focusComposer');
      const stageAllDef = sessionDef('session.stageAll');
      const timelineNextDef = sessionDef('session.timelineNext');
      const timelinePrevDef = sessionDef('session.timelinePrev');

      return [
        // ── Conversations ──────────────────────────────────────────────────
        {
          ...sideSessionDef,
          // spec session-resume:任务内没有「新建会话」这个动作了 —— 新建必须带首轮,
          // 而那个只填标题的弹窗给不出首轮。这里给的是从当前会话分一支临时的侧边任务;
          // 真正的新建走 app.newSession(⌘N),它带着第一句话。
          execute() {
            startSideSession(projectId, sessionId);
          },
        },
        {
          ...sidebarChangesDef,
          // #6780 旧侧栏的两个页签由会话里的 review 页签和文件夹 App 接班(旧的 setSidebarTab 已无处挂载)。
          // 开页签与空态、「+」菜单点按钮是同一个动作;两种都是 single 挂载,已开着就只激活、❌ 开第二个。
          execute() {
            sessionView?.paneLayout.open('review', {});
          },
        },
        {
          ...sidebarFilesDef,
          execute() {
            sessionView?.paneLayout.open(WORKSPACE_APP_KIND, {}, { preview: false });
          },
        },
        // ── Terminals ─────────────────────────────────────────────────────
        // 「终端」开关关着:命令面板和快捷键里都没有终端(设置 → 通用)。
        ...(terminalEnabledSnapshot()
          ? [
              {
                ...viewTerminalsDef,
                execute() {
                  // spec 会话页: terminals are workspace tabs, not a drawer — open one as a tab.
                  void sessionView?.openTerminalAsTab();
                },
              },
              {
                ...newTerminalDef,
                execute() {
                  // spec 会话页: a new terminal opens as a workspace tab (unified), not the legacy drawer.
                  void sessionView?.openTerminalAsTab();
                },
              },
            ]
          : []),
        {
          ...openBrowserDef,
          execute() {
            sessionView?.paneLayout.open('browser', {});
            sessionView?.setFocusedRegion('main');
          },
        },
        {
          ...browserGoBackDef,
          enabled: activeBrowserResource != null && (activeBrowserSession?.canGoBack ?? false),
          execute() {
            if (!activeBrowserResource) return;
            const adapter = browserControlsRegistry.get(activeBrowserResource.browserId)?.adapter;
            if (adapter?.canGoBack()) adapter.goBack();
          },
        },
        {
          ...browserGoForwardDef,
          enabled: activeBrowserResource != null && (activeBrowserSession?.canGoForward ?? false),
          execute() {
            if (!activeBrowserResource) return;
            const adapter = browserControlsRegistry.get(activeBrowserResource.browserId)?.adapter;
            if (adapter?.canGoForward()) adapter.goForward();
          },
        },
        {
          ...browserReloadDef,
          enabled: activeBrowserResource != null,
          execute() {
            if (!activeBrowserResource) return;
            browserControlsRegistry.get(activeBrowserResource.browserId)?.adapter?.reload();
          },
        },
        {
          ...browserFocusUrlDef,
          enabled: activeBrowserResource != null,
          execute() {
            if (!activeBrowserResource) return;
            browserControlsRegistry.get(activeBrowserResource.browserId)?.focusUrl();
          },
        },
        {
          ...browserOpenExternalDef,
          enabled: activeBrowserResource != null,
          execute() {
            if (!activeBrowserResource || !activeBrowserSession) return;
            const normalized = normalizeBrowserUrl(activeBrowserSession.currentUrl);
            if (
              normalized.ok &&
              (normalized.protocol === 'http:' || normalized.protocol === 'https:')
            ) {
              void rpc.app.openExternal(normalized.url);
            }
          },
        },
        ...(activeBrowserSession
          ? [
              {
                ...browserCopyUrlDef,
                execute() {
                  const normalized = normalizeBrowserUrl(activeBrowserSession.currentUrl, {
                    allowSearchQueries: false,
                  });
                  if (!normalized.ok) return;
                  void copyExternalLink(normalized.url, 'Browser URL copied');
                },
              },
            ]
          : []),

        // ── Git ────────────────────────────────────────────────────────────
        {
          ...gitFetchDef,
          enabled: repository != null,
          execute() {
            if (repository) void runGitFetch(repository);
          },
        },
        {
          ...gitPullDef,
          enabled: git != null,
          execute() {
            if (git) void runGitPull(git);
          },
        },
        {
          ...gitPushDef,
          // Dynamic label: push vs publish branch
          label: git?.isBranchPublished ? 'Git Push' : 'Git Publish Branch',
          description: git?.isBranchPublished
            ? 'Push commits to remote'
            : 'Publish this branch to remote',
          enabled: git != null,
          execute() {
            if (!git) return;
            if (git.isBranchPublished) {
              void runGitPush(git);
            } else {
              if (!repository) return;
              void runGitPublishBranch({
                repository,
                branchName: git.branchName,
                workspaceId: sessionPageStore.workspaceId ?? undefined,
              });
            }
          },
        },

        // ── Task actions ───────────────────────────────────────────────────
        {
          ...archiveDef,
          // 它点名的是**当前打开的那条会话**(spec session-graph:标签说「归档任务」,动的是这条
          // conversation)。没有打开任何会话时这一格灰掉 —— ❌ 让一个按键去归档一个它没点名的东西。
          enabled: sessionData != null && !sessionData.archivedAt && archiveTargetSessionId() != null,
          // 「Mod+Shift+E」也走同一条 archive-session-flow:一个默认绑好的按键静默归档,正是
          // `interface.confirmBeforeArchive`(归档前询问)要挡的那一下。关掉确认后它照旧一按即归档,
          // 并且按**默认范围**走(只这一条)——一个不弹的确认不能替用户勾上递归。
          execute() {
            // 归档后离开这项 task 的视图由 requestArchiveSession 统一负责(只在这次归档带走了这项
            // task 全部活会话时才离开)—— 它还认得独立任务住的隐藏 task-home 项目,这里原来那条
            // 无条件 navigate('project') 会把人送进那个用户从没见过的项目主页。
            const sessionId = archiveTargetSessionId();
            if (!sessionId) return;
            requestArchiveSession({ projectId, sessionId });
          },
        },

        // ── Focus & accessibility ─────────────────────────────────────────
        {
          ...focusSidebarDef,
          execute() {
            // behavior session-page「键盘导航」: 落点必须是导航层光标,不是「侧栏里第一个能聚焦的东西」。
            // 原来抓到的是侧栏顶上的一个按钮,于是 ⌘0 之后 ↑↓ 走不动会话 —— 「切到会话列再切回来」
            // 那条链在这里就断了。
            if (sessionKeyboardNav.leaveComposer()) return;
            const sidebar = document.querySelector<HTMLElement>('[data-region="left-sidebar"]');
            const focusable = sidebar?.querySelector<HTMLElement>(
              '[tabindex="0"], button, a, input'
            );
            focusable?.focus();
          },
        },
        {
          ...pinDef,
          label: sessionData?.isPinned ? 'Unpin Task' : 'Pin Task',
          description: sessionData?.isPinned
            ? 'Remove this task from pinned'
            : 'Pin this task to keep it at the top',
          enabled: sessionData != null,
          execute() {
            if (sessionData) void sessionPageStore?.setPinned(!sessionData.isPinned);
          },
        },
        {
          ...focusComposerDef,
          execute() {
            // Target the TipTap ProseMirror editor specifically, falling back to
            // any contenteditable or textarea within the composer region.
            const composer = document.querySelector<HTMLElement>('[data-region="composer"]');
            if (!composer) return;
            const input = composer.querySelector<HTMLElement>(
              '.tiptap[contenteditable="true"], .ProseMirror[contenteditable="true"], [contenteditable="true"], textarea'
            );
            input?.focus();
          },
        },
        {
          ...stageAllDef,
          enabled: git != null,
          execute() {
            if (git) void git.stageAllFiles();
          },
        },
        {
          ...timelineNextDef,
          execute() {
            const timeline = document.querySelector<HTMLElement>(
              '[data-region="session-timeline"]'
            );
            if (!timeline) return;
            const ticks = timeline.querySelectorAll<HTMLElement>('[data-tick-index]');
            const selectedIdx = Array.from(ticks).findIndex(
              (t) => t.dataset.tickSelected === 'true'
            );
            const nextIdx = selectedIdx + 1 < ticks.length ? selectedIdx + 1 : 0;
            ticks[nextIdx]?.click();
          },
        },
        {
          ...timelinePrevDef,
          execute() {
            const timeline = document.querySelector<HTMLElement>(
              '[data-region="session-timeline"]'
            );
            if (!timeline) return;
            const ticks = timeline.querySelectorAll<HTMLElement>('[data-tick-index]');
            const selectedIdx = Array.from(ticks).findIndex(
              (t) => t.dataset.tickSelected === 'true'
            );
            const prevIdx = selectedIdx > 0 ? selectedIdx - 1 : ticks.length - 1;
            ticks[prevIdx]?.click();
          },
        },
      ];
    },
  };
}
