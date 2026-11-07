import { observer } from 'mobx-react-lite';
import type { TabBarItemProps, TabProvider, TabResource, TabViewContext, ResolvedTab } from '@renderer/features/tabs/core/tab-provider';
import { createTabProvider } from '@renderer/features/tabs/core/tab-provider-registry';
import { registeredTabView } from '@renderer/features/tabs/core/tab-views';
import type { SessionTabContext } from '@renderer/features/tabs/core/session-tab-context';
import { GenericTabDragPreview, GenericTabItem } from '@renderer/features/tabs/tab-bar/generic-tab-item';
import { FileIcon } from '@renderer/lib/editor/file-icon';
import { fileTabLabels } from '@renderer/features/tabs/file-tab-label';
import { fileBaseName, filePathKey, resolveWorkspacePath } from '../stores/workspace-path';

export interface FileViewState {
  path: string;
  isExternal?: boolean;
}

export interface FileViewOpenArgs {
  path: string;
  /** Outside the session's working copy: addressed by its absolute path, on the session's machine. */
  external?: boolean;
}

export class FileViewResource implements TabResource {
  readonly title = null;
  constructor(readonly path: string, readonly isExternal: boolean) {}
  dispose(): void {}
}

const icon = (path: string) => (
  <span className="shrink-0 [&>svg]:h-3 [&>svg]:w-3">
    <FileIcon filename={fileBaseName(path)} className="shrink-0 text-foreground-muted" />
  </span>
);

const FileViewTabBarItem = observer(function FileViewTabBarItem({ tab, host, ctx }: TabBarItemProps<FileViewResource>) {
  const tabs = host.resolvedTabs.filter((t): t is ResolvedTab<FileViewResource> => t.kind === 'file-view');
  const { name, hint } = fileTabLabels(tabs.map((t) => t.resource))[tabs.findIndex((t) => t.tabId === tab.tabId)] ?? { name: fileBaseName(tab.resource.path) };
  return <GenericTabItem tab={tab} host={host} ctx={ctx} label={name} hint={hint} tooltip={tab.resource.path} preSlot={icon(tab.resource.path)} />;
});

/** A session's file no App opens and no editor edits, in the preview a chat's file opens in. */
export const fileViewTabProvider: TabProvider<'file-view', FileViewState, FileViewResource, FileViewOpenArgs> = createTabProvider({
  kind: 'file-view',
  resourceKey: (state: FileViewState) => filePathKey(state.path),
  onBeforeOpen: (args: FileViewOpenArgs, ctx: TabViewContext): FileViewState => ({
    path: resolveWorkspacePath((ctx as SessionTabContext).workspacePath, args.path),
    isExternal: args.external,
  }),
  initialize: (entry) => new FileViewResource(entry.state.path, entry.state.isExternal ?? false),
  dispose: (_entry, resource) => resource.dispose(),
  TabBarItem: FileViewTabBarItem,
  TabBarItemDragPreview: observer(({ tab }: { tab: ResolvedTab<FileViewResource> }) => (
    <GenericTabDragPreview label={fileBaseName(tab.resource.path)} preSlot={icon(tab.resource.path)} />
  )),
  TabContent: registeredTabView('file-view'),
});
