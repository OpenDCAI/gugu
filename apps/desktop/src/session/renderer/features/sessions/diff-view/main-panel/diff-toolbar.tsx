import { AlignJustify } from '@/lib/icons'
import { Columns2 } from 'lucide-react'
import { observer } from 'mobx-react-lite';
import type { DiffTabResource } from '@renderer/features/sessions/diff-view/stores/diff-tab-resource';
import { useWorkspaceSurface } from '@renderer/features/sessions/session-view-context';
import { MicroLabel } from '@renderer/lib/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@renderer/lib/ui/toggle-group';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { panelHeaderBarClass } from '@renderer/lib/ui/panel-header-bar';
import { cn } from '@renderer/utils/utils';

interface DiffToolbarProps {
  tab: DiffTabResource;
}

export const DiffToolbar = observer(function DiffToolbar({ tab }: DiffToolbarProps) {
  const { translate } = useSessionMessages();
  const diffView = useWorkspaceSurface().diffView;
  const diffStyle = diffView?.diffStyle;
  const canPreview = tab.renderer.kind === 'text' && tab.renderer.previewKind !== undefined;

  const diffSourceLabel = (() => {
    if (tab.diffGroup === 'staged') return 'Staged';
    if (tab.diffGroup === 'disk') return 'Changed';
    if (tab.diffGroup === 'pr') return 'PR';
    if (tab.diffGroup === 'git') return 'Git';
    return undefined;
  })();

  if (!diffView || !diffStyle) return null;

  return (
    <div className={cn(panelHeaderBarClass, 'justify-between gap-2')}>
      <div className="flex items-center gap-3">
        {diffSourceLabel && <MicroLabel>{diffSourceLabel}</MicroLabel>}
      </div>
      <div className="flex items-center gap-2">
        {canPreview && (
          <ToggleGroup
            size="sm"
            multiple={false}
            value={[tab.viewMode]}
            onValueChange={([value]) => {
              if (value === 'diff' || value === 'preview') tab.setViewMode(value);
            }}
          >
            <ToggleGroupItem value="diff" className="text-xs">
              {translate('diff.diff')}
            </ToggleGroupItem>
            <ToggleGroupItem value="preview" className="text-xs">
              {translate('diff.preview')}
            </ToggleGroupItem>
          </ToggleGroup>
        )}
        {tab.viewMode === 'diff' && (
          <ToggleGroup
            size="sm"
            multiple={false}
            value={[diffStyle]}
            onValueChange={([value]) => {
              if (value) {
                diffView.setDiffStyle(value as 'unified' | 'split');
              }
            }}
          >
            <ToggleGroupItem value="unified">
              <AlignJustify className="h-3.5 w-3.5" />
            </ToggleGroupItem>
            <ToggleGroupItem value="split">
              <Columns2 className="h-3.5 w-3.5" />
            </ToggleGroupItem>
          </ToggleGroup>
        )}
      </div>
    </div>
  );
});
