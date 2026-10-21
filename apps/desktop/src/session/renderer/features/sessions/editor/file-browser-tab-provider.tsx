import { FileText } from '@/lib/icons'
import type { ResolvedTab, TabBarItemProps, TabHandle, TabResource } from '@renderer/features/tabs/core/tab-provider';
import { createTabProvider } from '@renderer/features/tabs/core/tab-provider-registry';
import { registeredTabView } from '@renderer/features/tabs/core/tab-views';
import { GenericTabDragPreview, GenericTabItem } from '@renderer/features/tabs/tab-bar/generic-tab-item';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

type FileBrowserState = Record<string, never>;

export interface FileBrowserResource extends TabResource {
  handle: TabHandle;
}

function FileBrowserTabItem({ tab, host, ctx }: TabBarItemProps<FileBrowserResource>) {
  const { translate } = useSessionMessages();
  return (
    <GenericTabItem
      tab={tab}
      host={host}
      ctx={ctx}
      label={translate('workspace.files')}
      preSlot={<FileText className="size-3" />}
    />
  );
}

function FileBrowserTabDragPreview({ tab: _tab }: { tab: ResolvedTab<FileBrowserResource> }) {
  const { translate } = useSessionMessages();
  return (
    <GenericTabDragPreview
      preSlot={<FileText className="size-3" />}
      label={translate('workspace.files')}
    />
  );
}

export const fileBrowserTabProvider = createTabProvider({
  kind: 'file-browser',
  mount: 'single',
  resourceKey: () => 'open-file',
  onBeforeOpen: (): FileBrowserState => ({}),
  initialize(_entry, handle): FileBrowserResource {
    return { handle, dispose() {} };
  },
  dispose() {},
  TabBarItem: FileBrowserTabItem,
  TabBarItemDragPreview: FileBrowserTabDragPreview,
  TabContent: registeredTabView('file-browser')
});
