import { sessionKeyboardNav } from '@renderer/features/sidebar/session-keyboard-nav';
import { applyHistoryEntry } from '@renderer/lib/components/nav-buttons';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { openShellFeedback } from '@renderer/lib/open-shell-feedback';
import { openShellSettings } from '@renderer/lib/open-shell-settings';
import { appState } from '@renderer/lib/stores/app-state';
import { toggleHostTheme } from '@renderer/lib/theme/host-theme';
import { COMMANDS, type CommandId } from '@shared/commands';
import { openShellChatAction } from '@renderer/features/sidebar/sidebar-chats-section';
import { commandRegistry } from './registry';
import type { AppCommand, CommandProvider } from './types';

function appDef<T extends CommandId>(id: T): (typeof COMMANDS)[T] {
  return COMMANDS[id];
}

function isLibraryView(viewId: string): boolean {
  return viewId === 'library';
}

function createAppCommandProvider(): CommandProvider {
  return {
    scopeId: 'app',

    getCommands(): AppCommand[] {
      // Reads MobX observables — reactions automatically invalidate activeCommands
      // when navigation changes.
      const viewId = appState.navigation.currentViewId;
      const params = appState.navigation.viewParamsStore[viewId] as
        | { projectId?: string }
        | undefined;
      const projectId = params?.projectId;

      const settingsDef = appDef('app.settings');
      const libraryDef = appDef('app.library');
      const newProjectDef = appDef('app.newProject');
      const giveFeedbackDef = appDef('app.giveFeedback');
      const toggleThemeDef = appDef('app.toggleTheme');
      const navigateBackDef = appDef('app.navigateBack');
      const navigateForwardDef = appDef('app.navigateForward');

      const commands: AppCommand[] = [
        {
          ...settingsDef,
          // 设置是壳的弹窗:命令只负责打开,关掉是弹窗自己的事(Esc / ✕)。
          execute() {
            openShellSettings();
          },
        },
        {
          ...libraryDef,
          execute() {
            if (isLibraryView(appState.navigation.currentViewId)) {
              appState.navigation.navigate(appState.navigation.lastNonLibraryView);
              return;
            }

            appState.navigation.navigate('library');
          },
        },
        {
          ...newProjectDef,
          execute() {
            // 「新建项目」命令 = 行为文档里的「新建空白项目」(仅命名,落默认项目目录)。
            // 旧的 AddProjectModal(Pick/New/Clone)已删:不在产品预期里,能力被菜单项覆盖。
            showModal('createProjectNameModal', { onSuccess: () => {} });
          },
        },
      ];

      const sessionHistoryDef = appDef('app.sessionHistory');
      commands.push({
        ...sessionHistoryDef,
        execute() {
          appState.navigation.navigate('session-history');
        },
      });

      // gugu-dev#181 ⑯ 侧栏上那几个入口在 ⌘K 面板里也能到:执行的就是那几行点下去的同一件事。
      const scheduledDef = appDef('app.scheduled');
      const newGroupChatDef = appDef('app.newGroupChat');
      const addContactDef = appDef('app.addContact');
      commands.push(
        {
          ...scheduledDef,
          execute() {
            appState.navigation.navigate('automations');
          },
        },
        {
          ...newGroupChatDef,
          execute() {
            openShellChatAction('create-group');
          },
        },
        {
          ...addContactDef,
          execute() {
            openShellChatAction('add-contact');
          },
        },
      );

      commands.push({
        ...giveFeedbackDef,
        execute() {
          openShellFeedback();
        },
      });

      commands.push({
        ...toggleThemeDef,
        execute() {
          // @@@task-fusion (#2802) — 从前这里走会话页自己的 app-settings(异步、可能失败,
          // 所以有个失败 toast)。主题收敛成 `<html data-theme>` 一份真值后,翻转就是一次 DOM
          // 写入:同步、不会失败,失败分支跟着一起删。
          toggleHostTheme();
        },
      });

      const newSessionDef = appDef('app.newSession');
      commands.push({
        ...newSessionDef,
        execute() {
          // 在项目里:与项目行的「新建」同一条路,回到这个项目,在那里带着第一句话建(#5690)。
          // 不在项目里:与侧栏「新建会话」同一条路,去新建会话页。
          // ❌ 不开旧的 taskModal —— 那是只填标题 + 关联 issue 的旧残留(behavior session-resume)。
          if (projectId) appState.navigation.navigate('project', { projectId });
          else appState.navigation.navigate('new-session');
        },
      });

      const showKeyboardShortcutsDef = appDef('app.showKeyboardShortcuts');
      commands.push(
        {
          ...navigateBackDef,
          enabled: appState.history.canGoBack,
          hideFromPalette: true,
          execute() {
            appState.history.back(applyHistoryEntry);
          },
        },
        {
          ...navigateForwardDef,
          enabled: appState.history.canGoForward,
          hideFromPalette: true,
          execute() {
            appState.history.forward(applyHistoryEntry);
          },
        },
        {
          ...showKeyboardShortcutsDef,
          execute() {
            showModal('keyboardShortcutsModal', {});
          },
        }
      );

      commands.push(
        { id: 'session.rename', hideFromPalette: sessionKeyboardNav.cursor?.kind !== 'conversation', execute: (task) => sessionKeyboardNav.startRename(task ? { kind: 'conversation', ...task } : undefined) },
        { id: 'app.resourceMonitor', execute: () => openShellSettings('resource-monitor') },
      );
      return commands;
    },
  };
}

/**
 * Registers the app-scope CommandProvider. Must be called once at startup.
 * The provider is permanent — it reacts to navigation changes via MobX
 * observables inside getCommands().
 */
export function setupAppCommandProvider(): void {
  commandRegistry.register(createAppCommandProvider());
}
