import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { Braces, Eye } from '@/lib/icons'
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

interface FileContentToolbarProps {
  tab: FileTabResource;
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
  canToggle,
  treeVisible,
  onTreeVisibleChange
}: FileContentToolbarProps) {
  const { translate } = useSessionMessages();
  const { projectId } = useSessionViewContext();
  const canOpenLocally = tab.isExternal || workspaceBackend(projectId).tree.canReveal;
  const fileTreeToggleLabel = translate(treeVisible ? 'task.hideFileTree' : 'task.showFileTree');
  const sourceLabel = translate('task.viewSource');
  const previewLabel = translate('task.viewPreview');
  // #6950: in a narrow pane (the right pane opens 320px wide) the Source / Preview words become icons, so the bar keeps
  // room for the file's name; the words stay the buttons' names and tooltips.
  return (
    <div className={cn(panelHeaderBarClass, '@container/file-toolbar justify-between gap-2')}>
      <FilePathBreadcrumb path={tab.path} />
      <div className="flex shrink-0 items-center gap-1">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={fileTreeToggleLabel}
          title={fileTreeToggleLabel}
          onClick={() => onTreeVisibleChange(!treeVisible)}
        >
          {treeVisible ? (
            <PanelRightClose className="size-3.5" />
          ) : (
            <PanelRightOpen className="size-3.5" />
          )}
        </Button>
        {canToggle && (
          <ToggleGroup
            size="sm"
            multiple={false}
            value={[tab.viewMode]}
            onValueChange={([value]) => {
              if (value === 'preview' || value === 'source') tab.setViewMode(value);
            }}
          >
            <ToggleGroupItem value="source" className="text-xs" aria-label={sourceLabel} title={sourceLabel}>
              <Braces className="hidden size-3.5 @max-[30rem]/file-toolbar:block" />
              <span className="@max-[30rem]/file-toolbar:hidden">{sourceLabel}</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="preview" className="text-xs" aria-label={previewLabel} title={previewLabel}>
              <Eye className="hidden size-3.5 @max-[30rem]/file-toolbar:block" />
              <span className="@max-[30rem]/file-toolbar:hidden">{previewLabel}</span>
            </ToggleGroupItem>
          </ToggleGroup>
        )}
        {/* 「在 Finder / 编辑器里打开」只对这台电脑上的文件有意义(别的机器上的路径这里没有)。 */}
        {canOpenLocally && (
          <OpenInMenu
            path={tab.path}
            className="bg-transparent"
            borderless
          />
        )}
      </div>
    </div>
  );
});
