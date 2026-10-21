import { observer } from 'mobx-react-lite';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { SidebarSessionItem } from './sidebar-session-item';
import { SidebarGroup, SidebarMenu, sidebarGroupHeaderClass } from './sidebar-primitives';
import { SidebarGroupToggle } from './sidebar-group-toggle';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

// spec session-page: pinned CONVERSATIONS gather at the very top of the sidebar (below the quick
// actions), leaving their state groups. The section is collapsible.
export const SidebarPinnedSessionList = observer(function SidebarPinnedSessionList() {
  const { translate } = useSessionMessages();
  const entries = sidebarStore.pinnedSessionEntries;
  if (entries.length === 0) return null;
  const collapsed = sidebarStore.pinnedCollapsed;

  return (
    // 分区之间同一道呼吸(mb-2),三个分区头才读得出是三个分区。
    <SidebarGroup className="mb-2 flex shrink-0 flex-col">
      <div className={sidebarGroupHeaderClass}>
        <SidebarGroupToggle
          label={translate('sidebar.pinned')}
          count={entries.filter((entry) => !entry.depth).length}
          collapsed={collapsed}
          onToggle={() => sidebarStore.togglePinnedCollapsed()}
          ariaLabel={collapsed ? translate('sidebar.expandPinned') : translate('sidebar.collapsePinned')}
        />
      </div>
      {!collapsed && (
        <SidebarMenu className="pb-1">
          {entries.map(
            ({ projectId, sessionId, depth, parentProjectId, hasChildren, needsAttention, join }) => (
              <SidebarSessionItem
                key={sessionId}
                projectId={projectId}
                sessionId={sessionId}
                rowVariant="section"
                depth={depth}
                parentProjectId={parentProjectId}
                hasChildren={hasChildren}
                needsAttention={needsAttention}
                expanded={sidebarStore.expandedSessionIds.has(sessionId)}
                onToggle={() => sidebarStore.toggleSessionExpanded(sessionId)}
                join={join}
              />
            )
          )}
        </SidebarMenu>
      )}
    </SidebarGroup>
  );
});
