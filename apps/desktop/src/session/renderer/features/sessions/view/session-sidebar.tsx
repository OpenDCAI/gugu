import { observer } from 'mobx-react-lite';
import { useWorkspaceViewModel } from '@renderer/features/sessions/session-view-context';
import { ShowHide } from '@renderer/lib/ui/show-hide';
import { ChangesPanel } from '../diff-view/changes-panel/changes-panel';
import { EditorFileTree } from '../editor/editor-file-tree';

export const SessionSidebar = observer(function SessionSidebar() {
  const sessionView = useWorkspaceViewModel();
  const { isSidebarCollapsed, sidebarTab: activeTab } = sessionView;

  return (
    <div
      className="h-full min-h-0 overflow-hidden"
      style={isSidebarCollapsed ? { display: 'none' } : undefined}
    >
      <ShowHide visible={sessionView.isChangesPanelVisible} lazy>
        <ChangesPanel />
      </ShowHide>
      <ShowHide visible={activeTab === 'files'}>
        <EditorFileTree />
      </ShowHide>
    </div>
  );
});
