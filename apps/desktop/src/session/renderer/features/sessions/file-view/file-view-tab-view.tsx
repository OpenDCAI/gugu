import { observer } from 'mobx-react-lite';
import type { SessionTabContext } from '@renderer/features/tabs/core/session-tab-context';
import type { ResolvedTab, TabContentProps } from '@renderer/features/tabs/core/tab-provider';
import { RetainedTabContent, useRetainedTabs } from '@renderer/features/tabs/retained-tab-content';
import { resolveWorkspacePath } from '../stores/workspace-path';
import type { FileViewResource } from './file-view-tab-provider';
import { WorkspaceFileView } from './workspace-file-view';

export const TabContent = observer(function FileViewTabContent({ host, ctx }: TabContentProps) {
  const tabs = host.resolvedTabs.filter((t): t is ResolvedTab<FileViewResource> => t.kind === 'file-view');
  const retained = useRetainedTabs(tabs.map((t) => t.tabId), tabs.filter((t) => t.isActive).map((t) => t.tabId));
  const { projectId, workspaceId, sessionId, workspacePath } = ctx as SessionTabContext;
  return (
    <>
      {tabs.filter((t) => retained.has(t.tabId)).map((t) => (
        <RetainedTabContent key={t.tabId} className="absolute inset-0 flex min-h-0 min-w-0 flex-col" visible={t.isActive}>
          <WorkspaceFileView
            tabId={t.tabId}
            root={workspacePath}
            projectId={projectId}
            workspaceId={workspaceId}
            sessionId={sessionId}
            path={t.resource.path}
            absolutePath={resolveWorkspacePath(workspacePath, t.resource.path)}
            inWorkspace={!t.resource.isExternal}
            onClose={() => void host.closeTab(t.tabId)}
          />
        </RetainedTabContent>
      ))}
    </>
  );
});
