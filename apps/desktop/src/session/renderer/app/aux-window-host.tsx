import { reaction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { UiPortalContainerProvider } from '@gugu/session-ui/react/primitives';
import { ArrowLeft } from '@/lib/icons';
import { readRendererPlatform } from '@/lib/window-chrome';
import { AUX_WINDOW_NAME_PREFIX } from '@shared/aux-window';
import type { BrowserWebviewElement } from '@renderer/features/browser/browser-webview-types';
import { ExtensionMark } from '@renderer/features/extensions/extension-mark';
import { extensionSurfaceStore, extensionTabTitle } from '@renderer/features/extensions/extension-surface-store';
import { ExtensionTabToolbar } from '@renderer/features/extensions/extension-tab-toolbar';
import { extensionViewStore } from '@renderer/features/extensions/extension-view-store';
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import { TabBarActionRow } from '@renderer/features/sessions/titlebar-actions';
import { sessionView } from '@renderer/features/sessions/view';
import { WindowTabPane, WindowTabPaneContent } from '@renderer/features/sessions/view/window-tab-pane';
import { readChatSummary } from '@/lib/chatSummariesBridge';
import { TabStripShell } from '@renderer/features/tabs/tab-bar';
import { TabChip, TabSlot } from '@renderer/features/tabs/tab-bar/tab-chip';
import { mirrorDocument, bridgeHotkeys } from '@renderer/lib/aux-document';
import { ShellTitlebarDragRegion } from '@renderer/lib/components/titlebar/shell-titlebar';
import { rpc } from '@renderer/lib/ipc';
import { WorkspaceContentLayout } from '@renderer/lib/layout/workspace-layout';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import { auxWindows, type AuxChatTabContent, type AuxTabContent, type AuxWindow } from './aux-windows';
import { PageShownContext } from './recent-session-pages';
import { AUX_WINDOW_TRAFFIC_LIGHTS_PX, ScreenBlockContext, type ScreenBlockPlace } from './screen-block-context';
import { putBackFromWindow, windowClosed, windowFocused } from './screen-layout-actions';

/**
 * 单独成窗的那几扇窗(spec session-page「一屏几块」,照 VS Code 的浮动编辑器窗口):同一个渲染进程开一扇同源空白窗,
 * 把那块的界面直接画进去 —— 数据、会话、终端都是同一份,只是画在另一扇窗里。挂在会话页的根上(和 App 的页同层),
 * 不在 Workspace 里:那棵树会因为对话页「新建 Agent」整棵换掉,窗里的东西不该跟着没了。
 *
 * 搬进窗、放回来各重建一次界面:终端接回同一个进程、记录不丢;浏览器页签、App 的页会重新载入(网页换了窗口必然如此)。
 */
export const AuxWindowHost = observer(function AuxWindowHost() {
  return (
    <>
      {[...auxWindows.windows.values()].map((window) => (
        <AuxWindowFrame key={window.id} window={window} />
      ))}
    </>
  );
});

type Mounted = { win: Window; root: HTMLElement; layer: HTMLElement };

const AuxWindowFrame = observer(function AuxWindowFrame({ window: aux }: { window: AuxWindow }) {
  const { id } = aux;
  const [mounted, setMounted] = useState<Mounted | null>(null);

  useLayoutEffect(() => {
    const at = aux.at;
    const features = ['width=1040', 'height=760', ...(at ? [`left=${Math.round(at.screenX - 120)}`, `top=${Math.round(at.screenY - 20)}`] : [])];
    const win = window.open('about:blank', `${AUX_WINDOW_NAME_PREFIX}${id}`, features.join(','));
    if (!win) {
      log.warn('[aux-window] the window could not be opened', { id });
      windowClosed(id);
      return;
    }
    const doc = win.document;
    const stopMirror = mirrorDocument(document, doc);
    Object.assign(doc.body.style, { margin: '0', height: '100vh', overflow: 'hidden' });
    // 界面根:和会话页的挂载点同一套皮肤(深浅色、咕咕皮肤的作用域)。
    const skinSource = (window as Window & { __EMDASH_MOUNT__?: HTMLElement }).__EMDASH_MOUNT__ ?? document.querySelector('.gugu-skin');
    const root = doc.createElement('div');
    root.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column';
    const copySkin = () => {
      root.className = skinSource?.className ?? 'gugu-skin';
    };
    copySkin();
    const skinObserver = new MutationObserver(copySkin);
    if (skinSource) skinObserver.observe(skinSource, { attributes: true, attributeFilter: ['class'] });
    // 菜单、浮层、提示落在这扇窗里(不然会开在主窗上)。
    const layer = doc.createElement('div');
    layer.className = root.className;
    doc.body.append(root, layer);

    const stopHotkeys = bridgeHotkeys(doc);
    let closingOurselves = false;
    const onFocus = () => windowFocused(id);
    const onGone = () => {
      if (!closingOurselves) windowClosed(id);
    };
    win.addEventListener('focus', onFocus);
    win.addEventListener('pagehide', onGone);
    auxWindows.setHandle(id, win);
    setMounted({ win, root, layer });
    win.focus();

    return () => {
      closingOurselves = true;
      win.removeEventListener('focus', onFocus);
      win.removeEventListener('pagehide', onGone);
      stopHotkeys();
      skinObserver.disconnect();
      stopMirror();
      setMounted(null);
      if (!win.closed) win.close();
    };
    // 一扇窗一生只开一次;它装的东西不换(换 = 关了重开)。
  }, [id]);

  const title = useWindowTitle(aux);
  useEffect(() => {
    if (mounted) mounted.win.document.title = title;
  }, [mounted, title]);

  if (!mounted) return null;
  return createPortal(
    <UiPortalContainerProvider value={mounted.layer}>
      {aux.content.kind === 'session' ? (
        <AuxSessionPage windowId={id} projectId={aux.content.projectId} sessionId={aux.content.sessionId} />
      ) : aux.content.kind === 'tab' || aux.content.kind === 'chat-tab' ? (
        <AuxTabPage windowId={id} content={aux.content} />
      ) : (
        <AuxAppPage windowId={id} tabKind={aux.content.tabKind} />
      )}
    </UiPortalContainerProvider>,
    mounted.root
  );
});

function useWindowTitle(aux: AuxWindow): string {
  // 一枚页签的窗:标题是它那条会话(页签自己的名字由各类页签各自画,窗口标题认会话就够分清)。
  if (aux.content.kind === 'session' || aux.content.kind === 'tab') {
    const { sessionId } = aux.content;
    return sessionRegistry.get(sessionId)?.sessions.get(sessionId)?.data.title ?? '';
  }
  // 一个对话的一枚页签:标题是那个对话。
  if (aux.content.kind === 'chat-tab') return readChatSummary(aux.content.chatId)?.name ?? '';
  const { tabKind } = aux.content;
  return installedExtensionsStore.allTabContributions.find((entry) => entry.kind === tabKind)?.title ?? '';
}

/** 窗里的会话页:和屏上一块里的那一页是同一个东西,只是这扇窗就是它的一块(它是唯一一块,焦点跟着这扇窗)。 */
const AuxSessionPage = observer(function AuxSessionPage({
  windowId,
  projectId,
  sessionId,
}: {
  windowId: string;
  projectId: string;
  sessionId: string;
}) {
  const focused = auxWindows.focusedWindowId === windowId;
  const place = useMemo<ScreenBlockPlace>(
    () => ({ blockId: null, focused, topLeft: true, topRight: true, multi: false, windowId }),
    [focused, windowId]
  );
  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-aux-window={windowId}>
      <PageShownContext.Provider value={true}>
        <ScreenBlockContext.Provider value={place}>
          <sessionView.WrapView projectId={projectId} sessionId={sessionId}>
            <WorkspaceContentLayout titlebarSlot={<ShellTitlebarDragRegion />} mainPanel={<sessionView.MainPanel />} />
          </sessionView.WrapView>
        </ScreenBlockContext.Provider>
      </PageShownContext.Provider>
    </div>
  );
});

/** 窗里的一枚页签:它那条会话的上下文里,画它那一格。那一格没了(✕ 掉了它)窗就关。 */
const AuxTabPage = observer(function AuxTabPage({ windowId, content }: { windowId: string; content: AuxTabContent | AuxChatTabContent }) {
  const { home, paneId } = content;
  useEffect(
    () =>
      reaction(
        () => home.windowPanes.has(paneId),
        (open) => {
          if (!open) auxWindows.remove(windowId);
        },
        { fireImmediately: true }
      ),
    [home, paneId, windowId]
  );
  const focused = auxWindows.focusedWindowId === windowId;
  const place = useMemo<ScreenBlockPlace>(
    () => ({ blockId: null, focused, topLeft: true, topRight: true, multi: false, windowId }),
    [focused, windowId]
  );
  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-aux-window={windowId}>
      <PageShownContext.Provider value={true}>
        <ScreenBlockContext.Provider value={place}>
          {content.kind === 'tab' ? (
            <sessionView.WrapView projectId={content.projectId} sessionId={content.sessionId}>
              <WindowTabPane windowId={windowId} paneId={paneId} />
            </sessionView.WrapView>
          ) : (
            // A chat's tab: the same strip and content, from the chat's strip (its content drawn by the shell into its slot).
            <div className="relative flex h-full min-h-0 w-full flex-col bg-background text-foreground" data-aux-window={windowId}>
              <ShellTitlebarDragRegion />
              <WindowTabPaneContent windowId={windowId} paneId={paneId} paneLayout={content.home} />
            </div>
          )}
        </ScreenBlockContext.Provider>
      </PageShownContext.Provider>
    </div>
  );
});

/** 窗里那枚「放回咕咕」:回到主窗这屏(照原型窗口标题栏上那颗)。 */
export function PutBackButton({ windowId }: { windowId: string }) {
  const { translate } = useSessionMessages();
  const label = translate('screen.putBack');
  return (
    <button
      type="button"
      title={label}
      data-put-back=""
      className="flex h-6 items-center gap-1 rounded-md px-2 text-xs text-foreground-muted hover:bg-row-hover hover:text-foreground"
      onClick={() => putBackFromWindow(windowId)}
    >
      <ArrowLeft className="size-3.5" />
      {label}
    </button>
  );
}

/** mac 上窗的页签条左端让开红绿灯;别的平台标题栏是系统自己那一行,页签条不用让。 */
export const auxLeadingReserve = (): number => (readRendererPlatform() === 'mac' ? AUX_WINDOW_TRAFFIC_LIGHTS_PX : 0);

/** 窗里的 App:顶上一条页签条(只有它一枚,右端「放回咕咕」),下面是它的页。 */
const AuxAppPage = observer(function AuxAppPage({ windowId, tabKind }: { windowId: string; tabKind: string }) {
  const contribution = installedExtensionsStore.allTabContributions.find((entry) => entry.kind === tabKind);
  const { label, tooltip } = extensionTabTitle(extensionSurfaceStore.said(null, `window:${windowId}`), installedExtensionsStore.tabTitle(tabKind) ?? tabKind);
  const focused = auxWindows.focusedWindowId === windowId;
  return (
    <div className="relative flex h-full min-h-0 w-full flex-col bg-background text-foreground" data-aux-window={windowId}>
      <ShellTitlebarDragRegion />
      <TabStripShell
        leadingReservePx={auxLeadingReserve()}
        actionsSlot={
          <TabBarActionRow atWindowEdge>
            <PutBackButton windowId={windowId} />
          </TabBarActionRow>
        }
      >
        <TabSlot data-app-window-tab={tabKind}>
          <TabChip
            isActive
            isFocusedPane={focused}
            label={label}
            title={tooltip}
            preSlot={<ExtensionMark iconDataUrl={contribution?.iconDataUrl} />}
            closeLabel={label}
            onClose={() => windowClosed(windowId)}
          />
        </TabSlot>
      </TabStripShell>
      {contribution ? (
        <>
          <ExtensionTabToolbar tabKind={tabKind} sessionId={null} tabId={`window:${windowId}`} />
          <AuxExtensionSurface windowId={windowId} tabKind={tabKind} extensionId={contribution.extensionId} />
        </>
      ) : null}
    </div>
  );
});

/**
 * App 在窗里的那张页。主窗那层的页摆不到另一扇窗里(它按主窗里一格的位置浮在上面),网页也不能挪窗不重载 ——
 * 所以窗里另开一张,主窗那张(此刻没有谁要它)收掉:同一时刻仍只有一张在跑。放回去时这张关掉,主窗那层再开一张。
 */
function AuxExtensionSurface({ windowId, tabKind, extensionId }: { windowId: string; tabKind: string; extensionId: string }) {
  const [surface, setSurface] = useState<{ partition: string; entryUrl: string } | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const sizeWatch = useRef<ResizeObserver | null>(null);
  const tabId = `window:${windowId}`;

  useEffect(() => {
    // 主窗那层里它那张页此刻没人要了(它刚从一块 / 一条会话里拿过来):收掉,❌ 两张同时跑。
    extensionViewStore.forgetIdle(tabKind);
    let disposed = false;
    void rpc.extensions
      .activate({ extensionId, tabKind })
      .then((result) => {
        if (disposed) return;
        if (result.success && result.data) setSurface(result.data);
        else log.warn('[aux-window] App activation failed:', result.error);
      })
      .catch((error: unknown) => log.warn('[aux-window] App activation failed:', error));
    return () => {
      disposed = true;
    };
  }, [extensionId, tabKind]);

  const attach = useCallback(
    (element: BrowserWebviewElement | null) => {
      if (!element) return;
      element.addEventListener('dom-ready', () => {
        const webContentsId = element.getWebContentsId();
        void rpc.extensions.bindSurface({ webContentsId, extensionId, tabKind, tabId }).then((result) => {
          if (!result.success) {
            log.warn('[aux-window] App surface binding refused:', result.error);
            return;
          }
          extensionSurfaceStore.setWebContentsId(null, tabId, webContentsId);
          // 尺寸报给桥:它按真实宽度排版;窗口一改大小再报一次。
          const box = boxRef.current;
          if (!box) return;
          const report = () =>
            void rpc.extensions
              .reportLayout({ webContentsId, visible: true, width: box.clientWidth, height: box.clientHeight })
              .catch(() => {});
          report();
          // 页每载入一次(dom-ready)换一个盯尺寸的,旧的撤掉。
          sizeWatch.current?.disconnect();
          sizeWatch.current = new ResizeObserver(report);
          sizeWatch.current.observe(box);
        });
      });
    },
    [extensionId, tabId, tabKind]
  );

  useEffect(
    () => () => {
      sizeWatch.current?.disconnect();
      sizeWatch.current = null;
      extensionSurfaceStore.setWebContentsId(null, tabId, null);
    },
    [tabId]
  );

  return (
    <div ref={boxRef} className="min-h-0 flex-1 bg-background">
      {surface ? (
        <webview
          key={`${extensionId}:${surface.partition}`}
          ref={attach}
          src={surface.entryUrl}
          partition={surface.partition}
          className="h-full w-full bg-background"
        />
      ) : null}
    </div>
  );
}
