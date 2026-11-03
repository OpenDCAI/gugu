import { ArrowLeft, ArrowRight, MoreHorizontal, PanelRightClose, PanelRightOpen } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import { OpenInMenu } from '@renderer/lib/components/titlebar/open-in-menu';
import { useSessionViewContext } from '@renderer/features/sessions/session-view-context';
import { workspaceBackend } from '@renderer/features/sessions/workspace-backend/workspace-backend';
import { Button } from '@renderer/lib/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@renderer/lib/ui/toggle-group';
import { FilePathBreadcrumb } from './file-path-breadcrumb';
import type { FileTabResource } from './stores/file-tab-resource';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { panelHeaderBarClass } from '@renderer/lib/ui/panel-header-bar';
import { cn } from '@renderer/utils/utils';
import type { TabHost } from '@renderer/features/tabs/core/tab-host';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@renderer/lib/ui/dropdown-menu';

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
  const sourceLabel = translate('tabs.edit');
  const previewLabel = translate('tabs.read');
  // #6950: in a narrow pane (the right pane opens 320px wide) the Source / Preview words become icons, so the bar keeps
  // room for the file's name; the words stay the buttons' names and tooltips.
  return (
    <div className={cn(panelHeaderBarClass, '@container/file-toolbar justify-between gap-2')}>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="ghost" className="gap-1 text-xs" aria-label={translate('tabs.back')} title={translate('tabs.back')} disabled={!host.canGo(tabId, -1)} onClick={() => void host.go(tabId, -1)}><ArrowLeft className="size-3.5" />{translate('tabs.back')}</Button>
        <Button size="icon-sm" variant="ghost" aria-label={translate('tabs.forward')} title={translate('tabs.forward')} disabled={!host.canGo(tabId, 1)} onClick={() => void host.go(tabId, 1)}><ArrowRight className="size-3.5" /></Button>
      </div>
      <FilePathBreadcrumb path={tab.path} />
      <div className="flex shrink-0 items-center gap-1">
        {canToggle && (
          <ToggleGroup
            size="sm"
            multiple={false}
            value={[tab.viewMode]}
            onValueChange={([value]) => {
              if (value === 'preview' || value === 'source') tab.setViewMode(value);
            }}
          >
            <ToggleGroupItem value="preview" className="text-xs" aria-label={previewLabel} title={previewLabel}>
              {previewLabel}
            </ToggleGroupItem>
            <ToggleGroupItem value="source" className="text-xs" aria-label={sourceLabel} title={sourceLabel}>{sourceLabel}</ToggleGroupItem>
          </ToggleGroup>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={translate('tabs.more')} title={translate('tabs.more')} />}><MoreHorizontal className="size-3.5" /></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onTreeVisibleChange(!treeVisible)}>{treeVisible ? <PanelRightClose /> : <PanelRightOpen />}{fileTreeToggleLabel}</DropdownMenuItem>
            {canOpenLocally && <div className="px-2 py-1"><OpenInMenu path={tab.path} className="bg-transparent" borderless /></div>}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
});
