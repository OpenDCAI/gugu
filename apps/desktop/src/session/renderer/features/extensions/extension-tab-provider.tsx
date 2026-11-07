import { when } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useContext, useMemo } from 'react';
import { PaneContext } from '@renderer/features/tabs/pane-context';
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
import { extensionTabKind, parseExtensionTabKind } from '@shared/extensions/manifest';
import { declaredMenuCommands, runExtensionCommand } from './extension-commands';
import { ExtensionTabBadge } from './extension-tab-badge';
import { ExtensionMark } from './extension-mark';
import { ExtensionTabPane } from './extension-tab-pane';
import { ExtensionSharedSlot } from './extension-shared-slot';
import { extensionViewStore, residentPageKey, residentPlace } from './extension-view-store';
import { extensionSurfaceStore, extensionTabTitle } from './extension-surface-store';
import { installedExtensionsStore, WORKSPACE_APP_ID } from './installed-extensions-store';
import { useScreenBlock } from '@renderer/app/screen-block-context';
import { placeOnScreen } from '@renderer/app/screen-layout-actions';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { fileTabLabels } from '@renderer/features/tabs/file-tab-label';
import { fileBaseName, filePathKey } from '@renderer/features/sessions/stores/workspace-path';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { rpc } from '@renderer/lib/ipc';
import { Folder } from '@/lib/icons';
import { FileIcon } from '@renderer/lib/editor/file-icon';

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
    private readonly readHoldsUnsaved?: () => boolean,
  ) {}

  get holdsUnsaved(): boolean {
    return this.readHoldsUnsaved?.() ?? false;
  }

  get title(): string | undefined {
    return this.readTitle?.();
  }

  dispose(): void {
    // The surface unmounts with the tab. The extension's session outlives it and
    // is torn down on uninstall, not on close.
  }
}

/** File and folder pages share the same per-tab navigation context; hidden pages retain their own state. */
/** The tab is one per task (manifest `perSession`, #7317): every task keeps its own, none is moved from another. */
function isPerSession(kind: string): boolean {
  return installedExtensionsStore.allTabContributions.find((entry) => entry.kind === kind)?.perSession === true;
}

/**
 * A tab with unsaved edits asks before it goes, the same question for any file: save, drop, or stay. Only its page can do
 * either, and it answers by saying again whether anything is unsaved. Not saved (the disk or the machine out of reach): it stays.
 */
async function confirmCloseOfUnsaved(sessionId: string | null, tabId: string, filePath?: string): Promise<boolean> {
  const { dirtyIn, dirtyReports } = extensionSurfaceStore.state(sessionId, tabId);
  if (dirtyIn === null) return true;
  const choice = await new Promise<'save' | 'discard' | null>((resolve) =>
    showModal('unsavedChangesModal', {
      fileName: fileBaseName(filePath ?? ''),
      onSuccess: (result) => resolve(result === 'save' ? 'save' : 'discard'),
      onClose: () => resolve(null),
    })
  );
  if (!choice) return false;
  const told = await rpc.extensions.invokeCommand({ webContentsId: dirtyIn, commandId: `gugu.file.${choice}:${tabId}` });
  // The page is gone: its edits wait in their draft, and come back when the file opens again.
  if (!told.success) return true;
  await when(() => extensionSurfaceStore.state(sessionId, tabId).dirtyReports > dirtyReports);
  return extensionSurfaceStore.state(sessionId, tabId).dirtyIn === null;
}

function createExtensionTabContent(extensionId: string, kind: string) {
  return observer(function ExtensionTabContent({ host, ctx }: TabContentProps) {
    const pane = useContext(PaneContext)?.pane;
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
    const history = host.navigationOf(activeTab.tabId);
    const opener = pane?.openerOf(activeTab.tabId);
    const backToConversation = (history?.index ?? 0) === 0 && !!opener && pane!.registry.has(opener.kind) && pane!.registry.get(opener.kind).conversation === true;
    const navigation = { canBack: !!pane?.canGo(activeTab.tabId, -1), canForward: !!history && history.index < history.pages.length - 1, backToConversation };
    const place = ctx.place;
    const sessionId = place?.kind === 'session' ? place.sessionId : undefined;
    if (!resource.filePath) {
      return <ExtensionSharedSlot tabKind={kind} sessionId={sessionId} chatId={place?.kind === 'chat' ? place.chatId : undefined} tabId={activeTab.tabId} navigation={navigation} viewState={host.navigationOf(activeTab.tabId)?.pages[host.navigationOf(activeTab.tabId)!.index]?.viewState} perSession={isPerSession(kind)} />;
    }
    return (
      <ExtensionTabPane
        extensionId={extensionId}
        tabKind={kind}
        sessionId={sessionId ?? null}
        tabId={activeTab.tabId}
        navigation={navigation}
        viewState={history?.pages[history.index]?.viewState}
        filePath={resource.filePath}
      />
    );
  });
}

/** The extension's own mark on its tab, read live so an upgrade swaps it in place. */
const ExtensionTabIcon = observer(function ExtensionTabIcon({ kind, file }: { kind: string; file?: string }) {
  // The folder App's tabs say what they show: the list a folder, a file its type. Its own mark stays in the App lists.
  if (parseExtensionTabKind(kind)?.extensionId === WORKSPACE_APP_ID) {
    return file ? <span className="flex shrink-0 text-foreground-muted"><FileIcon filename={fileBaseName(file)} className="shrink-0" /></span> : <Folder className="size-3 text-foreground-muted" />;
  }
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
    resourceKey: (state: ExtensionTabState) => (state?.filePath ? filePathKey(state.filePath) : 'app'),
    onBeforeOpen: (args: ExtensionTabState): ExtensionTabState => args?.filePath ? { filePath: args.filePath } : (isPerSession(kind) ? { perSession: true } : {}),
    // `entry.state` is the only path a per-tab fact travels on, and until now it
    // was read by nobody — which is why a tab could not be told which file it was
    // opened for. Reading it here is what makes the file claim mean anything.
    initialize: (entry, _handle, ctx) => new ExtensionTabResource(extensionId, entry.state?.filePath, () => {
      if (entry.state?.filePath) return fileBaseName(entry.state.filePath);
      const surface = extensionSurfaceStore.sharedState(residentPageKey(kind, residentPlace({ ...ctx.place, tabId: entry.tabId, perSession: isPerSession(kind) })));
      return extensionTabTitle(surface, titleOf()).label;
    }, () => extensionSurfaceStore.state(ctx.place?.kind === 'session' ? ctx.place.sessionId : null, entry.tabId).dirtyIn !== null),
    dispose: (entry, resource: ExtensionTabResource, ctx) => {
      // Drop what the extension said about this tab along with the tab. A
      // reopened tab is a new one and starts at its manifest title, not at the
      // last title some earlier session happened to leave behind.
      const sessionId = ctx.place?.kind === 'session' ? ctx.place.sessionId : null;
      extensionSurfaceStore.forget(sessionId, entry.tabId);
      resource.dispose();
    },
    onBeforeClose: (entry, _resource, ctx) => confirmCloseOfUnsaved(ctx.place?.kind === 'session' ? ctx.place.sessionId : null, entry.tabId, entry.state?.filePath),
    closed: (tabId, ctx) => extensionViewStore.closeSlot(ctx.place?.kind === 'session' ? ctx.place.sessionId : null, tabId),

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
        : extensionSurfaceStore.sharedState(residentPageKey(kind, residentPlace({ ...place, tabId: tab.tabId, perSession })));
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
          preSlot={<ExtensionTabIcon kind={kind} file={claimedFile} />}
          statusSlot={own.dirtyIn !== null
            ? <div className="size-2 rounded-full bg-foreground" title={translateSessionMessage('task.unsavedChanges')} />
            : <ExtensionTabBadge badge={surface.badge} />}
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
