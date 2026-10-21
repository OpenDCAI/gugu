import { applyHistoryEntry } from '@renderer/lib/components/nav-buttons';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { openShellFeedback } from '@renderer/lib/open-shell-feedback';
import { openShellSettings } from '@renderer/lib/open-shell-settings';
import { appState } from '@renderer/lib/stores/app-state';
import { toggleHostTheme } from '@renderer/lib/theme/host-theme';
import { APP_COMMAND_DEFS, type AppCommandId, type CommandDef } from '@shared/commands';
import { commandRegistry } from './registry';
import type { AppCommand, CommandProvider } from './types';

function appDef(id: AppCommandId): CommandDef {
  return APP_COMMAND_DEFS.find((d) => d.id === id)!;
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
          id: settingsDef.id,
          label: settingsDef.label,
          description: settingsDef.description,
          shortcutKey: settingsDef.shortcutKey,
          group: settingsDef.group,
          // 设置是壳的弹窗:命令只负责打开,关掉是弹窗自己的事(Esc / ✕)。
          execute() {
            openShellSettings();
          },
        },
        {
          id: libraryDef.id,
          label: libraryDef.label,
          description: libraryDef.description,
          shortcutKey: libraryDef.shortcutKey,
          group: libraryDef.group,
          execute() {
            if (isLibraryView(appState.navigation.currentViewId)) {
              appState.navigation.navigate(appState.navigation.lastNonLibraryView);
              return;
            }

            appState.navigation.navigate('library');
          },
        },
        {
          id: newProjectDef.id,
          label: newProjectDef.label,
          description: newProjectDef.description,
          shortcutKey: newProjectDef.shortcutKey,
          group: newProjectDef.group,
          execute() {
            // 「新建项目」命令 = 行为文档里的「新建空白项目」(仅命名,落默认项目目录)。
            // 旧的 AddProjectModal(Pick/New/Clone)已删:不在产品预期里,能力被菜单项覆盖。
            showModal('createProjectNameModal', { onSuccess: () => {} });
          },
        },
      ];

      const sessionHistoryDef = appDef('app.sessionHistory');
      commands.push({
        id: sessionHistoryDef.id,
        label: sessionHistoryDef.label,
        description: sessionHistoryDef.description,
        group: sessionHistoryDef.group,
        execute() {
          appState.navigation.navigate('session-history');
        },
      });

      commands.push({
        id: giveFeedbackDef.id,
        label: giveFeedbackDef.label,
        description: giveFeedbackDef.description,
        shortcutKey: giveFeedbackDef.shortcutKey,
        group: giveFeedbackDef.group,
        execute() {
          openShellFeedback();
        },
      });

      commands.push({
        id: toggleThemeDef.id,
        label: toggleThemeDef.label,
        description: toggleThemeDef.description,
        shortcutKey: toggleThemeDef.shortcutKey,
        group: toggleThemeDef.group,
        execute() {
          // @@@task-fusion (#2802) — 从前这里走会话页自己的 app-settings(异步、可能失败,
          // 所以有个失败 toast)。主题收敛成 `<html data-theme>` 一份真值后,翻转就是一次 DOM
          // 写入:同步、不会失败,失败分支跟着一起删。
          toggleHostTheme();
        },
      });

      if (projectId) {
        const newSessionDef = appDef('app.newSession');
        commands.push({
          id: newSessionDef.id,
          label: newSessionDef.label,
          description: newSessionDef.description,
          shortcutKey: newSessionDef.shortcutKey,
          group: newSessionDef.group,
          execute() {
            // 与项目行的「新建」同一条路:回到这个项目的首页,在那里带着第一句话建(#5690)。
            // ❌ 不开旧的 taskModal —— 那是只填标题 + 关联 issue 的旧残留(behavior session-resume)。
            appState.navigation.navigate('project', { projectId });
          },
        });
      }

      const showKeyboardShortcutsDef = appDef('app.showKeyboardShortcuts');
      commands.push(
        {
          id: navigateBackDef.id,
          label: navigateBackDef.label,
          description: navigateBackDef.description,
          shortcutKey: navigateBackDef.shortcutKey,
          group: navigateBackDef.group,
          enabled: appState.history.canGoBack,
          hideFromPalette: true,
          execute() {
            appState.history.back(applyHistoryEntry);
          },
        },
        {
          id: navigateForwardDef.id,
          label: navigateForwardDef.label,
          description: navigateForwardDef.description,
          shortcutKey: navigateForwardDef.shortcutKey,
          group: navigateForwardDef.group,
          enabled: appState.history.canGoForward,
          hideFromPalette: true,
          execute() {
            appState.history.forward(applyHistoryEntry);
          },
        },
        {
          id: showKeyboardShortcutsDef.id,
          label: showKeyboardShortcutsDef.label,
          description: showKeyboardShortcutsDef.description,
          shortcutKey: showKeyboardShortcutsDef.shortcutKey,
          group: showKeyboardShortcutsDef.group,
          execute() {
            showModal('keyboardShortcutsModal', {});
          },
        }
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
