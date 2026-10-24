import type { ComponentType, ReactNode } from 'react';
import { homeView } from '@renderer/app/home-view';
import { appsView, appView } from '@renderer/features/apps/apps-views';
import { assistantView } from '@renderer/features/assistant/assistant-view';
import { automationsView } from '@renderer/features/automations/automations-view';
import { chatView } from '@renderer/features/chats/view';
import { libraryView } from '@renderer/features/library/library-view';
import { projectView } from '@renderer/features/projects/view';
import { sessionHistoryView } from '@renderer/features/session-history/session-history-view';
import { NewSessionPage } from '@renderer/features/sessions/new-session-page';
import { ShellTitlebar } from '@renderer/lib/components/titlebar/shell-titlebar';
import { sessionView } from '@renderer/features/sessions/view';
import type { CommandProvider } from '@renderer/lib/commands/types';
import { appState } from '@renderer/lib/stores/app-state';
import { registerViews } from '@renderer/lib/layout/registered-views';

// Define views here so we can use them in the navigate function
export const views = {
  home: homeView,
  automations: automationsView,
  library: libraryView,
  // #7199 个人助理的一页(最左栏「助理」)。
  assistant: assistantView,
  project: projectView,
  // gugu-dev#181 对话也是一块。
  chat: chatView,
  screen: { MainPanel: () => null },
  'session-history': sessionHistoryView,
  session: sessionView,
  'new-session': { TitlebarSlot: ShellTitlebar, MainPanel: NewSessionPage },
  apps: appsView,
  app: appView,
  // oxlint-disable-next-line typescript/no-explicit-any
} satisfies Record<string, ViewDefinition<any>>;

export type ViewDefinition<TParams extends object = Record<never, never>> = {
  WrapView?: ComponentType<{ children: ReactNode } & TParams>;
  TitlebarSlot?: ComponentType;
  MainPanel: ComponentType;
  /**
   * Factory called by Workspace whenever this view becomes active.
   * The returned CommandProvider is registered in commandRegistry and
   * unregistered when the view changes or the params change.
   */
  commandProvider?: (params: TParams) => CommandProvider;
  /**
   * Called before navigation to this view is committed. Return { ok: false }
   * to redirect to a different view instead.
   *
   * Receives `unknown` because params can come from persisted snapshots written
   * by older builds, so each guard must validate the shape before using it.
   */
  canActivate?: (params: unknown) => GuardResult;
  /**
   * 只属于**这一次到访**的参数键。其余参数是「上次停在哪」,离开与重启都要记住;
   * 列在这里的键是「这次进去要干什么」的一次性意图,离开该视图即作废、也不从快照恢复。
   * 语义与丢弃时机见 navigation-store 的 `@@@transient-view-params`。
   */
  transientParams?: readonly (keyof TParams & string)[];
  /** A place of its own on the far-left rail (App, an App from the dock): drawn without the task list beside it. */
  withoutSessionSidebar?: true;
};

type Views = typeof views;

export type ViewId = keyof Views;

export type WrapParams<TId extends ViewId> = Views[TId] extends {
  WrapView: ComponentType<infer P>;
}
  ? Omit<P, 'children'>
  : Record<never, never>;

export type GuardResult =
  | { ok: true }
  | { ok: false; redirect: ViewId; params?: Record<string, unknown> };

export function setupNavigationGuards(): void {
  registerViews(views as unknown as Parameters<typeof registerViews>[0]);
  for (const [viewId, view] of Object.entries(views) as Array<
    [ViewId, ViewDefinition<Record<string, unknown>>]
  >) {
    appState.navigation.registerView(viewId, { transientParams: view.transientParams });
    if (view.canActivate) {
      appState.navigation.registerGuard(viewId, view.canActivate);
    }
  }
}
