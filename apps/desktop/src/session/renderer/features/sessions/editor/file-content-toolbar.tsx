import { MoreHorizontal, PanelRightClose, PanelRightOpen } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import { OpenInMenu } from '@renderer/lib/components/titlebar/open-in-menu';
import { useSessionViewContext } from '@renderer/features/sessions/session-view-context';
import { workspaceBackend } from '@renderer/features/sessions/workspace-backend/workspace-backend';
import { Button } from '@renderer/lib/ui/button';
import { FilePathBreadcrumb } from './file-path-breadcrumb';
import type { FileTabResource } from './stores/file-tab-resource';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { FileToolbar } from './file-toolbar';
import type { TabHost } from '@renderer/features/tabs/core/tab-host';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@renderer/lib/ui/dropdown-menu';
import { ZoomMenuRow } from '@/components/preview/ZoomMenuRow';
import type { FileZoomKind } from '@/components/preview/file-content-zoom';
import type { ManagedFileKind } from '@renderer/lib/editor/types';

/** The reading zoom a previewed file keeps; its source is always text-code. */
const PREVIEW_ZOOM: Partial<Record<ManagedFileKind, FileZoomKind>> = { text: 'text-code', csv: 'text-code', markdown: 'markdown', html: 'html', svg: 'image', image: 'image', pdf: 'pdf', docx: 'docx' };

interface FileContentToolbarProps {
  tab: FileTabResource;
  host: TabHost;
  tabId: string;
  canToggle: boolean;
  treeVisible: boolean;
  onTreeVisibleChange: (visible: boolean) => void;
}

/**
 * Top bar shown on every file tab: absolute-path breadcrumb on the left (segments drop down the
 * directory listing — product spec 文件 tab), Raw/Preview toggle and open-in-editor on the
 * right.
 */
export const FileContentToolbar = observer(function FileContentToolbar({
  tab,
  host,
  tabId,
  canToggle,
  treeVisible,
  onTreeVisibleChange
}: FileContentToolbarProps) {
  const { translate } = useSessionMessages();
  const { projectId } = useSessionViewContext();
  const canOpenLocally = tab.isExternal || workspaceBackend(projectId).tree.canReveal;
  const fileTreeToggleLabel = translate(treeVisible ? 'task.hideFileTree' : 'task.showFileTree');
  const zoomKind = tab.viewMode === 'source' ? 'text-code' : PREVIEW_ZOOM[tab.fileKind];
  // #6950: in a narrow pane (the right pane opens 320px wide) the Source / Preview words become icons, so the bar keeps
  // room for the file's name; the words stay the buttons' names and tooltips.
  return (
    <FileToolbar host={host} tabId={tabId} path={<FilePathBreadcrumb path={tab.path} />} mode={canToggle ? tab.viewMode : undefined} canEdit={canToggle} onModeChange={(mode) => tab.setViewMode(mode)} menu={<DropdownMenu>
          <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={translate('tabs.more')} title={translate('tabs.more')} />}><MoreHorizontal className="size-3.5" /></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onTreeVisibleChange(!treeVisible)}>{treeVisible ? <PanelRightClose /> : <PanelRightOpen />}{fileTreeToggleLabel}</DropdownMenuItem>
            {canOpenLocally && <div className="px-2 py-1"><OpenInMenu path={tab.path} className="bg-transparent" borderless /></div>}
            {zoomKind ? <><DropdownMenuSeparator /><ZoomMenuRow kind={zoomKind} /></> : null}
          </DropdownMenuContent>
        </DropdownMenu>} />
  );
});
