import type { LinkPlace } from '@gugu/core/shared/ui/guguLink';
import { events, rpc } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import { log } from '@renderer/utils/logger';
import { extensionsQuitChangedChannel } from '@shared/extensions/marketEvents';
import { extensionViewStore } from './extension-view-store';
import { installedExtensionsStore } from './installed-extensions-store';
import { openInWindow, returnToScreen, revealAppBlock, takeAppOffScreen } from '@renderer/app/screen-layout-actions';
import { appPlacementStore } from './app-placement-store';

/**
 * The far-left rail's dock — this machine's Apps pinned there, in order. One write of the whole list, as main keeps it:
 * pinning, taking off and reordering are the same verb. Optimistic, the answer kept; a refusal puts the list back and
 * reaches the caller, which says it.
 */
export async function setDock(ids: readonly string[]): Promise<void> {
  const store = installedExtensionsStore;
  const before = store.dock;
  store.applyDock(ids);
  try {
    const result = await rpc.extensions.setDock({ ids: [...ids] });
    if (!result.success || !result.data) throw new Error(result.error ?? 'the dock was not changed');
    store.applyDock(result.data.dock);
  } catch (error) {
    store.applyDock(before);
    throw error;
  }
}

export const pinToDock = (extensionId: string) =>
  setDock([...installedExtensionsStore.dock.filter((id) => id !== extensionId), extensionId]);

export const unpinFromDock = (extensionId: string) =>
  setDock(installedExtensionsStore.dock.filter((id) => id !== extensionId));

/**
 * Whether an App is running now — the dot beside its icon on the rail, as the macOS dock marks a running app (#7050).
 * It runs while a page of it is alive: on screen, or kept hidden after it was looked at (extension-view-store keeps a few),
 * or one opened for a file. And while it is on, if it has a background: that one lives exactly as long as the App is on
 * (extension-background.ts) — so being on and declaring one IS its running, not a copy of main's state.
 */
export function appIsRunning(extensionId: string): boolean {
  const store = installedExtensionsStore;
  if (store.isEnabled(extensionId) && !store.quit.includes(extensionId) && store.manifestFor(extensionId)?.background?.entry) return true;
  const kinds = new Set<string>(store.allTabContributions.filter((entry) => entry.extensionId === extensionId).map((entry) => entry.kind));
  return (
    [...extensionViewStore.residentPages.values()].some((page) => kinds.has(page.kind)) ||
    [...extensionViewStore.filePages.values()].some((page) => kinds.has(page.kind))
  );
}

/**
 * 点左栏一个 App 的图标(或右键「App」里的一行、它右键的「打开」)= **去它现在在的地方**:摆在某条会话里就去那条会话、
 * 把它那一枚翻到前面;哪都没摆着才整页打开(behavior tab-extensions「一个 App 只有一份、放在哪就在哪」,#7052)。
 */
export function openApp(extensionId: string, tab?: string): LinkPlace | 'own' {
  const main = tab ? installedExtensionsStore.allTabContributions.find((entry) => entry.extensionId === extensionId && entry.kind === `${extensionId}.${tab}`) : installedExtensionsStore.mainTabOf(extensionId);
  // 它正自己占着一块(spec session-page「一屏几块」):去会话页、看那一块。
  if (main && revealAppBlock(main.kind)) return 'own';
  const placed = main ? appPlacementStore.of(main.kind) : undefined;
  const navigation = appState.navigation;
  if (!main || !placed) {
    navigation.navigate('app', { appId: extensionId, ...(tab ? { tab } : {}) });
    return 'own';
  }
  navigation.navigate('session', { projectId: placed.projectId, sessionId: placed.sessionId });
  // 那条会话页可能还没在内存里:等它就绪再把那一枚翻到前面(和 agent 开一个 App 页签同一条路)。
  // 动态 import:那个模块拉着整套会话页 store,左栏不该一直背着它。
  void import('@renderer/features/sessions/stores/open-file-in-file-editor').then(({ openHostRequestedExtensionInSessionWhenReady }) =>
    openHostRequestedExtensionInSessionWhenReady({
      ...placed,
      tabKind: main.kind,
      intent: 'pinned',
      reveal: true,
      onResult: (result) => {
        if (!result.success) log.warn('Could not bring an App forward where it is placed:', result.error);
      },
    })
  );
  return { session: placed.sessionId };
}

/**
 * 「在新窗口打开」(左栏右键、它整页右上角的 ⧉):这个 App 单独成窗(它原来在哪就从哪拿过来;已经在窗里 = 提到前面)。
 * 正看着它的整页 = 先回到它后面那一页(和「退出」同一处),❌ 留一张空的整页在主窗里。
 */
export function openAppInWindow(extensionId: string): void {
  const main = installedExtensionsStore.mainTabOf(extensionId);
  if (!main) return;
  leaveAppPage(extensionId);
  openInWindow({ kind: 'app', tabKind: main.kind });
}

/** 正看着这个 App 的整页:回到消息工作区,与消息栏同一个恢复动作。 */
function leaveAppPage(extensionId: string): void {
  const navigation = appState.navigation;
  if (navigation.currentViewId !== 'app' || navigation.viewParamsStore.app?.appId !== extensionId) return;
  returnToScreen();
}

/**
 * 「退出」(#7050,左栏右键,照 macOS 程序坞退出一个 App):它摆着的地方都收掉、后台也停下;App 仍启用、仍钉在左栏。
 * 再点它、或从「+」放进来,就从头开始 —— 主进程在它的页被要的那一刻撤销退出、拉起后台。
 *
 * 「摆着的地方」:它在某条会话里的那一枚(拿走它的摆放,那条会话自己就收掉,#7052)、它的整页
 * (正看着就回到任务)、群右栏里开着它的那一格(GroupAppSlot 看到退出了自己关)。收完之后,藏着活的页一并销毁。
 */
export async function quitApp(extensionId: string): Promise<void> {
  const store = installedExtensionsStore;
  const kinds = store.allTabContributions.filter((entry) => entry.extensionId === extensionId);
  for (const { kind } of kinds) {
    appPlacementStore.take(kind);
    takeAppOffScreen(kind);
  }
  // Its page closes, and what was behind it shows: the tasks — the last one looked at, or the home of them (as 任务 does).
  leaveAppPage(extensionId);
  const result = await rpc.extensions.quit({ extensionId });
  if (!result.success || !result.data) throw new Error(result.error ?? 'the App was not quit');
  store.applyQuit(result.data.quit);
  // The places above unmount on the next render; only then are its pages idle, and those go.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  for (const { kind } of kinds) extensionViewStore.forgetIdle(kind);
}

/** Main says which Apps are quit whenever that changes — reopened from anywhere (a tab, a file, the rail) included. */
export function wireAppQuit(): () => void {
  return events.on(extensionsQuitChangedChannel, ({ quit }) => installedExtensionsStore.applyQuit(quit));
}
