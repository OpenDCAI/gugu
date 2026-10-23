import { action, observable } from 'mobx';
import { observer } from 'mobx-react-lite';
import { AppErrorDetails, AppErrorMark } from '@/components/appSlot/AppErrorMark';
import { WINDOW_CONTROL_BAR_HEIGHT_PX } from '@/lib/window-chrome';
import type { ReactNode } from 'react';
import type { ViewDefinition } from '@renderer/app/view-registry';
import { SquareArrowOutUpRight } from '@/lib/icons';
import { openAppInWindow } from '@renderer/features/extensions/app-dock';
import { ExtensionSharedSlot } from '@renderer/features/extensions/extension-shared-slot';
import { extensionSurfaceStore, extensionTabTitle } from '@renderer/features/extensions/extension-surface-store';
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store';
import { ExtensionsLibraryPage } from '@renderer/features/library/extensions-library-page';
import { LibraryHostProvider } from '@renderer/features/library/library-host';
import { useSelectedLibraryHost } from '@renderer/features/library/library-view';
import { DeviceScopeProvider } from '@renderer/features/remote-hosts/device-scope-picker';
import { libraryDeviceStore } from '@renderer/features/remote-hosts/device-scope-store';
import { TabBarActionRow } from '@renderer/features/sessions/titlebar-actions';
import { PageContent, PageLayout } from '@renderer/lib/components/page-layout';
import { ShellTitlebar } from '@renderer/lib/components/titlebar/shell-titlebar';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

/**
 * The far-left rail's 「App」: the person's Apps and the market — the page that was the library's 扩展 tab, as it was, with
 * the machine picker in its title (it has no column of its own to carry one). A place of its own on the rail, so no task
 * list beside it, like 消息 and 通讯录.
 */
const AppsMainPanel = observer(function AppsMainPanel() {
  const host = useSelectedLibraryHost();
  return (
    <PageLayout>
      {/* 照 Google Play 的应用首页铺满这一页(页面那层最宽 1060,owner 10-10「这个是我想要的」)。 */}
      <PageContent className="max-w-none">
        <DeviceScopeProvider store={libraryDeviceStore}>
          <LibraryHostProvider value={host} key={host.key}>
            <ExtensionsLibraryPage />
          </LibraryHostProvider>
        </DeviceScopeProvider>
      </PageContent>
    </PageLayout>
  );
});

export const appsView = {
  TitlebarSlot: ShellTitlebar,
  MainPanel: AppsMainPanel,
  withoutSessionSidebar: true,
} satisfies ViewDefinition;

type AppViewParams = { appId?: string };

/** Draws nothing: a view's params are typed from its WrapView's props (`WrapParams`), so `useParams('app')` knows appId. */
function AppViewWrapper({ children }: { children: ReactNode } & AppViewParams) {
  return <>{children}</>;
}

/**
 * The App page's error, as a chat's panel shows it (125 10-06): the mark in the title row beside the name, the whole of
 * it under that row when pressed. A notify or link naming no place opens this page, so it is a place like the others.
 * The two halves are drawn by the title bar and the main panel, so whether it is open is kept here, per App.
 */
const errorDetailsShown = observable.set<string>();
const toggleErrorDetails = action((kind: string) => {
  if (!errorDetailsShown.delete(kind)) errorDetailsShown.add(kind);
});
const pageError = () => extensionSurfaceStore.said(null, 'dock').error;

/**
 * 整页的顶栏:左边它的名字,右上角 ⧉ = 在新窗口打开(原型「它整页右上角 ⧉ = 窗口」)。⧉ 作用于这一页的内容,
 * 跟着内容走、贴窗口右缘(这页没有工作区面板那一簇),几何交给 <TabBarActionRow>,❌ 自己写 right-*。
 */
const AppTitlebar = observer(function AppTitlebar() {
  const { translate } = useSessionMessages();
  const { params } = useParams('app');
  const main = params.appId ? installedExtensionsStore.mainTabOf(params.appId) : null;
  const error = main ? pageError() : null;
  const heading = main ? extensionTabTitle(extensionSurfaceStore.said(null, 'dock'), main.extensionName) : null;
  const openInWindowLabel = translate('tabs.openInWindow');
  return (
    <ShellTitlebar
      leftSlot={
        main ? (
          <span className="flex min-w-0 items-center gap-1">
            <span className="text-sm font-medium" title={heading?.tooltip}>{heading?.label}</span>
            {error ? <AppErrorMark error={error} onToggle={() => toggleErrorDetails(main.kind)} testId="app-page-error" /> : null}
          </span>
        ) : null
      }
    >
      {main?.enabled && params.appId ? (
        <div className="absolute top-0 right-0 flex" style={{ height: WINDOW_CONTROL_BAR_HEIGHT_PX }}>
          <TabBarActionRow atWindowEdge>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={openInWindowLabel}
              title={openInWindowLabel}
              onClick={() => params.appId && openAppInWindow(params.appId)}
              data-testid="app-page-open-in-window"
            >
              <SquareArrowOutUpRight />
            </Button>
          </TabBarActionRow>
        </div>
      ) : null}
    </ShellTitlebar>
  );
});

/**
 * An App pinned to the rail, opened from it: its page of its own, filling the main area — the same live page a session's
 * tab shows, moved here, not a second one; leaving gives it back (the claims stack). Here it sits nowhere (真源原则 13):
 * no session, no chat in its context; what the person is looking at is `getAppState()`'s, and every call names its target.
 */
const AppMainPanel = observer(function AppMainPanel() {
  const { translate } = useSessionMessages();
  const { params } = useParams('app');
  const main = params.appId ? installedExtensionsStore.mainTabOf(params.appId) : null;
  const error = main?.enabled ? pageError() : null;
  // The title bar is a zero-height band over the top of the main area (the App's name, the window's handle): the page
  // starts under it, as a session's tabs do (tab-bar.tsx) — an App drawing from its top edge sat beneath its own name
  // (125 10-06), and so did the line a switched-off App gets. Inline: tokens.css's `*{padding:0}` wipes utilities
  // outside the skinned shell.
  return (
    <div className="flex h-full min-h-0 w-full flex-col" style={{ paddingTop: WINDOW_CONTROL_BAR_HEIGHT_PX }} data-testid="app-page">
      {!main?.enabled ? (
        <p className="text-sm text-foreground-muted" style={{ padding: 24 }}>{translate('extensions.turnOnInSettings')}</p>
      ) : (
        <>
          {error && errorDetailsShown.has(main.kind) ? <AppErrorDetails error={error} testId="app-page-error-details" /> : null}
          <ExtensionSharedSlot tabKind={main.kind} tabId="dock" />
        </>
      )}
    </div>
  );
});

export const appView = {
  WrapView: AppViewWrapper,
  TitlebarSlot: AppTitlebar,
  MainPanel: AppMainPanel,
  withoutSessionSidebar: true,
} satisfies ViewDefinition<AppViewParams>;
