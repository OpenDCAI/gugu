import { autorun } from 'mobx';
import type { sessionTabView } from '@renderer/features/sessions/session-tab-registry';
import { parseExtensionTabKind } from '@shared/extensions/manifest';
import { appPlacementStore } from './app-placement-store';
import { installedExtensionsStore } from './installed-extensions-store';

type SessionPaneLayout = ReturnType<typeof sessionTabView.createPaneLayoutStore>;

/** A tab of an App opened for its own sake (the resident one), not for a file it claims. */
const isResident = (state: unknown): boolean => !(state as { filePath?: string } | undefined)?.filePath;

/**
 * 一条会话只留下摆在自己这里的 App(behavior tab-extensions「一个 App 只有一份、放在哪就在哪」,#7052)。
 *
 * App 摆在哪只记在 appPlacementStore;这里是每条会话那一侧:它的常驻页签不是摆在这条会话的,就收掉。
 * 于是「放到别处 = 从原来那处拿过来」不必去找原来那条会话 —— 写一下那张表,原来那条会话自己就不留了;
 * 它此刻没在内存里也一样,下次打开、从存档读回来的那一刻就不留。改版前存下的布局里每条会话都有一枚
 * App 页签(那时「启用即每条会话都有一格」),读回来也是这样一并收掉。
 *
 * 只收不开:❌ 在这里替谁把 App 放回来。为文件开的那种不归这里管(一个文件一枚,关就是关);每个任务一份的
 * (`perSession`,#7317)也不归这里管:每个任务留着自己那一枚;
 * 有文件才有东西可看的 App(`forFiles`)没有常驻那一枚,有就收掉(摩擦单 F95)。
 *
 * 收用的是强关:这不是人在关它(人关它 = 从这里拿走,见 extension-tab-provider 的 onBeforeClose),不该再改那张表。
 */
export function startAppPlacementSync(paneLayout: SessionPaneLayout, sessionId: string): () => void {
  return autorun(() => {
    for (const { pane } of paneLayout.groups) {
      const doomed: string[] = [];
      for (const tabId of pane.tabOrder) {
        const entry = pane.entries.get(tabId);
        if (!entry || !parseExtensionTabKind(entry.kind) || !isResident(entry.state)) continue;
        const contribution = installedExtensionsStore.allTabContributions.find((c) => c.kind === entry.kind);
        if (contribution?.perSession || (entry.state as { perSession?: true } | undefined)?.perSession) continue;
        if (contribution?.forFiles || appPlacementStore.of(entry.kind)?.sessionId !== sessionId) doomed.push(tabId);
      }
      for (const tabId of doomed) pane.closeTab(tabId);
    }
  });
}
