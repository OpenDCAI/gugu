import { observer } from 'mobx-react-lite';
import { useMemo } from 'react';
import type {
  ResolvedTab,
  TabBarItemProps,
  TabContentProps,
  TabProvider,
  TabResource,
} from '@renderer/features/tabs/core/tab-provider';
import { createTabProvider } from '@renderer/features/tabs/core/tab-provider-registry';
import {
  GenericTabDragPreview,
  GenericTabItem,
} from '@renderer/features/tabs/tab-bar/generic-tab-item';
import { extensionTabKind } from '@shared/extensions/manifest';
import { declaredMenuCommands, runExtensionCommand } from './extension-commands';
import { ExtensionTabBadge } from './extension-tab-badge';
import { ExtensionMark } from './extension-mark';
import { ExtensionTabPane } from './extension-tab-pane';
import { ExtensionSharedSlot } from './extension-shared-slot';
import { extensionViewStore, residentPageKey, residentPlace } from './extension-view-store';
import { extensionSurfaceStore, extensionTabTitle } from './extension-surface-store';
import { installedExtensionsStore } from './installed-extensions-store';
import { useScreenBlock } from '@renderer/app/screen-block-context';
import { placeOnScreen, takeAppOffScreen } from '@renderer/app/screen-layout-actions';
import { appPlacementStore } from './app-placement-store';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { openFileInBuiltInEditor } from '@renderer/features/sessions/stores/open-file-in-file-editor';
import { fileTabLabels } from '@renderer/features/sessions/editor/file-tab-label';
import { fileBaseName, filePathKey } from '@renderer/features/sessions/stores/workspace-path';

/**
 * What the host knows about one open extension tab, stored per tab entry.
 *
 * `filePath` is set when this tab was opened BECAUSE it claimed a file type
 * (behavior tab-extensions:「认领某类文件的打开方式」) — the working-copy-relative
 * path the user asked to open. Absent for a tab opened from the entry rail: that
 * one was opened for its own sake and has no file to show.
 *
 * Set by the host, never by the surface. An extension that could write it would
 * be choosing which file it is looking at, and every file call is bounded by the
 * working copy precisely so that choice is not the extension's.
 */
export type ExtensionTabState = {
  filePath?: string;
  /**
   * 改版前(#7052 之前)开出来的那种页签各带一个现发的身份 —— 那时「一种类型可以开很多个」。存档里还留着,
   * 读回来不再用它:一个 App 只有一份,为自己开的那一枚按类型就是唯一的。
   */
  instanceId?: string;
  /**
   * #7317 This tab is one per task (manifest `perSession`), said on the tab itself: a layout restored before the App list
   * has loaded, or one whose App is gone, still knows it is this task's own and keeps it.
   */
  perSession?: true;
};

export class ExtensionTabResource implements TabResource {
  constructor(
    readonly extensionId: string,
    /** The claimed file this tab was opened for, if it was opened for one. */
    readonly filePath: string | undefined = undefined,
    private readonly readTitle?: () => string,
  ) {}

  get title(): string | undefined {
    return this.readTitle?.();
  }

  dispose(): void {
    // The surface unmounts with the tab. The extension's session outlives it and
    // is torn down on uninstall, not on close.
  }
}

/**
 * 两种格,两种页:
 *   · 认领文件开出来的 → 一个文件一份页,只有活动的那一格驮着它,切走就释放(ExtensionTabPane)。
 *   · 常驻的那一格(App 为自己开的,整个 app 只有一枚,摆在哪条会话里就在哪)→ 页整个 app 一张,住在根层;
 *     这里只是它此刻的落点(ExtensionSharedSlot)。挪到别的会话时页跟过去,不重建 ——
 *     behavior tab-extensions「挪地方、切会话时它纹丝不动」。
 */
/** The tab is one per task (manifest `perSession`, #7317): every task keeps its own, none is moved from another. */
function isPerSession(kind: string): boolean {
  return installedExtensionsStore.allTabContributions.find((entry) => entry.kind === kind)?.perSession === true;
}

function createExtensionTabContent(extensionId: string, kind: string) {
  return observer(function ExtensionTabContent({ host, ctx }: TabContentProps) {
    // 并排时屏上有两枚(spec session-page「并排」):挑自己这种里亮着的那枚。
    const activeTab = host.resolvedTabs.find((tab) => tab.isActive && tab.kind === kind);
    const resource = activeTab?.resource;
    if (
      !activeTab ||
      !(resource instanceof ExtensionTabResource) ||
      resource.extensionId !== extensionId
    ) {
      return null;
    }
    const place = ctx.place;
    const sessionId = place?.kind === 'session' ? place.sessionId : undefined;
    if (!resource.filePath) {
      return <ExtensionSharedSlot tabKind={kind} sessionId={sessionId} chatId={place?.kind === 'chat' ? place.chatId : undefined} tabId={activeTab.tabId} perSession={isPerSession(kind)} />;
    }
    return (
      <ExtensionTabPane
        extensionId={extensionId}
        tabKind={kind}
        sessionId={sessionId ?? null}
        tabId={activeTab.tabId}
        filePath={resource.filePath}
      />
    );
  });
}

/** The extension's own mark on its tab, read live so an upgrade swaps it in place. */
const ExtensionTabIcon = observer(function ExtensionTabIcon({ kind }: { kind: string }) {
  const iconDataUrl = installedExtensionsStore.allTabContributions.find(
    (entry) => entry.kind === kind
  )?.iconDataUrl;
  return (
    <ExtensionMark
      iconDataUrl={iconDataUrl}
      className="text-foreground-muted [&>svg]:h-3 [&>svg]:w-3"
    />
  );
});


/**
 * Builds a tab provider for one `contributes.tabs` entry of one extension.
 *
 * One provider per contribution, created at runtime from the manifest: an
 * extension's tab types are only knowable once it is installed. Refs #2374.
 */
export function createExtensionTabProvider(
  extensionId: string,
  tabName: string
): TabProvider<string, ExtensionTabState, ExtensionTabResource, ExtensionTabState> {
  const kind = extensionTabKind(extensionId, tabName);
  const TabContent = createExtensionTabContent(extensionId, kind);

  /**
   * Read from the store at render time rather than captured here: a provider
   * can only be registered once per kind, so a title captured now would be the
   * title forever — an upgrade that renames its tab would keep showing the old
   * name until the app restarted.
   */
  const titleOf = (): string =>
    installedExtensionsStore.tabTitle(kind) ?? tabName;

  return createTabProvider({
    kind,
    // 单挂,身份两种:
    //   · 认领的文件 → 身份 = 那个文件。语义是「替内置编辑器打开它」,就该和被替下来的
    //     那个一致(file-tab-provider: `resourceKey: (s) => filePathKey(s.path)`):同一个 a.sql 点第
    //     二次回到原来那个 tab,两个不同的 .sql 是两个 tab。
    //   · 为自己开的 → 一个 App 只有一枚(behavior tab-extensions「一个 App 只有一份」,#7052):
    //     在这条会话里再开一次 = 回到那一枚(在别的格里就挪过来),❌ 开出第二枚。
    // key 不必带 kind:单挂查找已经按 kind 分过组(PaneStore.findSingleMountEntry)。
    mount: 'single',
    resourceKey: (state: ExtensionTabState) => (state?.filePath ? filePathKey(state.filePath) : 'app'),
    // Its own page beside the conversation takes the width its manifest declares (`sideWidth`, read now: an update can
    // change it); a file opened in it is the conversation's peer, half each.
    sideWidth: (state: ExtensionTabState) => (state?.filePath ? undefined : installedExtensionsStore.sideWidth(kind)),
    /**
     * 每一条把它开出来的路(「+」、面板空态、左栏、agent 的 `open_in_tab`、链接)都经过这里,所以「摆到这里」
     * 只在这里记一次:记下的那一刻,原来摆着它的会话就不留它了(app-placement-sync)。为文件开的不记。
     */
    onBeforeOpen: (args: ExtensionTabState, ctx): ExtensionTabState => {
      if (args?.filePath) return { filePath: args.filePath };
      // 每个任务一份的(#7317):这个任务开它的,就是这个任务自己的那枚,❌ 从别的任务拿过来。
      if (isPerSession(kind)) return { perSession: true };
      if (ctx.place?.kind === 'session') {
        const { projectId, sessionId } = ctx.place;
        appPlacementStore.place(kind, { projectId, sessionId });
        // 它本来自己占着一块:那块收掉(一个 App 只有一份)。群里的页属于那个群,不挪群以外的那张。
        takeAppOffScreen(kind);
      }
      return {};
    },
    // `entry.state` is the only path a per-tab fact travels on, and until now it
    // was read by nobody — which is why a tab could not be told which file it was
    // opened for. Reading it here is what makes the file claim mean anything.
    initialize: (entry, _handle, ctx) => new ExtensionTabResource(extensionId, entry.state?.filePath, () => {
      if (entry.state?.filePath) return fileBaseName(entry.state.filePath);
      const surface = extensionSurfaceStore.sharedState(residentPageKey(kind, residentPlace({ ...ctx.place, perSession: isPerSession(kind) })));
      return extensionTabTitle(surface, titleOf()).label;
    }),
    /**
     * 人关掉常驻的那一枚 = **它从这里拿走**(behavior tab-extensions):App 照常启用、照常在跑,
     * 再要它从左栏、「+」或右键左栏「App」里拿。❌ 不是停用(那只在「App」页做),也 ❌ 不留在别处。
     * 认领文件开出来的那种:那一格是为某个文件开的,关就是关。
     */
    onBeforeClose: (entry, _resource, ctx) => {
      if (!entry.state?.filePath && !isPerSession(kind) && ctx.place?.kind === 'session') appPlacementStore.take(kind, { sessionId: ctx.place.sessionId });
      return true;
    },
    dispose: (entry, resource: ExtensionTabResource, ctx) => {
      // Drop what the extension said about this tab along with the tab. A
      // reopened tab is a new one and starts at its manifest title, not at the
      // last title some earlier session happened to leave behind.
      const sessionId = ctx.place?.kind === 'session' ? ctx.place.sessionId : null;
      extensionSurfaceStore.forget(sessionId, entry.tabId);
      resource.dispose();
    },

    // Observers, because the title is read from the store: reinstalling an
    // extension that renamed its tab updates the tab bar in place.
    TabBarItem: observer(function ExtensionTabBarItem({
      tab,
      host,
      ctx,
    }: TabBarItemProps<ExtensionTabResource>) {
      // What the extension has said about *this* tab wins over the manifest:
      // a live title is the whole point of letting it set one. The manifest
      // title stays the fallback, so a tab is never nameless.
      const place = ctx.place;
      const sessionId = place?.kind === 'session' ? place.sessionId : null;
      const own = extensionSurfaceStore.state(sessionId, tab.tabId);
      // 常驻的那一格对着的是这个任务里那张常驻页,它说的话按页记;认领文件的格才各记各的。
      const claimedFileForSurface =
        tab.resource instanceof ExtensionTabResource ? tab.resource.filePath : undefined;
      const perSession = isPerSession(kind);
      const surface = claimedFileForSurface
        ? own
        : extensionSurfaceStore.sharedState(residentPageKey(kind, residentPlace({ ...place, perSession })));
      // GenericTabItem 是 observer(= React.memo)。每次渲染给一个新数组身份,
      // 那层 memo 就永远比不中 —— 这是「稳定引用确有理由」的那种情况。
      // The file this tab was opened for, when a claim opened it.
      const claimedFile =
        tab.resource instanceof ExtensionTabResource ? tab.resource.filePath : undefined;
      const { blockId } = useScreenBlock();
      const kindCommands = useMemo(
        () => [
          // 「单独一块」(spec session-page「一屏几块」):它自己占一块,贴在这一块右边;这条会话里就不留它了。
          // 每个任务一份的不给:离开任务它就不是哪个任务的了。
          ...(!claimedFile && !perSession && blockId
            ? [
                {
                  id: `${kind}:own-block`,
                  label: translateSessionMessage('extensions.ownBlock'),
                  group: 'extension',
                  run: () => {
                    placeOnScreen({ kind: 'app', tabKind: kind }, blockId, 'right');
                  },
                },
              ]
            : []),

          // ⚠️ The escape hatch, and the reason a file claim is safe to honour at
          // all: without it, installing an extension could make a file type
          // unopenable — an ability no install may have. Host-provided and first,
          // so it cannot be hidden behind an extension's own entries.
          ...(claimedFile && place?.kind === 'session'
            ? [
                {
                  id: `${kind}:open-in-builtin-editor`,
                  label: translateSessionMessage('extensions.openInBuiltInEditor'),
                  group: 'extension',
                  run: () => {
                    openFileInBuiltInEditor(place.projectId, place.sessionId, claimedFile);
                  },
                },
              ]
            : []),
          ...declaredMenuCommands(kind).map((command) => ({
            id: `${kind}:${command.id}`,
            label: command.title,
            group: 'extension',
            run: () => {
              runExtensionCommand(sessionId, tab.tabId, command.id);
            },
          })),
        ],
        [blockId, claimedFile, perSession, place, sessionId, tab.tabId]
      );
      // 同一个 App 开着两个不同目录下的同名文件:与文件页签同一条规矩,补上区分它们的那截路径(file-tab-label.ts)。
      const claimedTabs = host.resolvedTabs.filter((t): t is ResolvedTab<ExtensionTabResource> => t.kind === kind && !!(t.resource as ExtensionTabResource).filePath);
      const pathHint = claimedFile
        ? fileTabLabels(claimedTabs.map((t) => ({ path: t.resource.filePath ?? '', title: null })))[claimedTabs.findIndex((t) => t.tabId === tab.tabId)]?.hint
        : undefined;
      const presentation = extensionTabTitle(surface, titleOf(), claimedFile ? { name: fileBaseName(claimedFile), path: claimedFile, hint: pathHint } : undefined);
      return (
        <GenericTabItem
          tab={tab}
          host={host}
          ctx={ctx}
          // 摩擦单 F95: a tab opened for a file says which file first — two of them, or the App's and the built-in
          // editor's on the same file, would otherwise read the same; the App and, for same-named files, the folder follow
          // in muted text (as a diff tab's group does). The whole path is in the tooltip.
          label={presentation.label}
          hint={presentation.hint}
          tooltip={presentation.tooltip}
          hasError={surface.error !== null}
          preSlot={<ExtensionTabIcon kind={kind} />}
          statusSlot={<ExtensionTabBadge badge={surface.badge} />}
          // Declared entries sit after the engine's own (close, split, …): the
          // host's commands are the ones a user expects in a fixed place, and an
          // extension does not get to push them down.
          kindCommands={kindCommands}
        />
      );
    }),

    TabBarItemDragPreview: observer(function ExtensionTabDragPreview() {
      return (
        <GenericTabDragPreview
          preSlot={<ExtensionTabIcon kind={kind} />}
          label={titleOf()}
        />
      );
    }),

    TabContent,
  });
}
