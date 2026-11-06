import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState } from 'react';
import { MessageFilePreview, type HostedPreviewFile } from '@/components/chat/MessageFilePreview';
import { registerHtmlPreview } from '@/components/preview/html-preview-registration';
import { mimeTypeFromName } from '@gugu/core/shared/imageMime.mjs';
import type { SessionTabContext } from '@renderer/features/tabs/core/session-tab-context';
import type { ResolvedTab, TabContentProps } from '@renderer/features/tabs/core/tab-provider';
import { RetainedTabContent, useRetainedTabs } from '@renderer/features/tabs/retained-tab-content';
import { quoteWorkspaceFile } from '@renderer/lib/editor/quote-workspace-file';
import { fileChangesChannel } from '@shared/core/fs/fsEvents';
import { workspaceBackend, workspaceEvents, workspaceRpc } from '../workspace-backend/workspace-backend';
import { openPathWithFailureToast } from '../stores/open-file-in-file-editor';
import { fileBaseName, resolveWorkspacePath } from '../stores/workspace-path';
import type { FileViewResource } from './file-view-tab-provider';

export const TabContent = observer(function FileViewTabContent({ host, ctx }: TabContentProps) {
  const tabs = host.resolvedTabs.filter((t): t is ResolvedTab<FileViewResource> => t.kind === 'file-view');
  const retained = useRetainedTabs(tabs.map((t) => t.tabId), tabs.filter((t) => t.isActive).map((t) => t.tabId));
  return (
    <>
      {tabs.filter((t) => retained.has(t.tabId)).map((t) => (
        <RetainedTabContent key={t.tabId} className="absolute inset-0 flex min-h-0 min-w-0 flex-col" visible={t.isActive}>
          <FileView resource={t.resource} ctx={ctx as SessionTabContext} onClose={() => void host.closeTab(t.tabId)} />
        </RetainedTabContent>
      ))}
    </>
  );
});

async function readBytes(projectId: string, workspaceId: string, path: string): Promise<Blob> {
  const result = await workspaceRpc(projectId).files.readInlineBinary(projectId, workspaceId, path);
  if (!result.success) throw new Error('message' in result.error ? result.error.message : String(result.error));
  if (!result.data.success) throw new Error(result.data.error);
  return (await fetch(result.data.dataUrl)).blob();
}

/** Its bytes through the session's workspace (whichever machine that is on), read again when the file changes there. */
function FileView({ resource, ctx, onClose }: { resource: FileViewResource; ctx: SessionTabContext; onClose: () => void }) {
  const { projectId, workspaceId, sessionId, workspacePath } = ctx;
  const { path, isExternal } = resource;
  const [revision, setRevision] = useState(0);
  useEffect(
    () =>
      workspaceEvents.on(fileChangesChannel, ({ workspaceId: changed, update }) => {
        if (changed !== workspaceId) return;
        if (update.kind === 'resync' || update.changes.some((change) => change.path === path)) setRevision((n) => n + 1);
      }),
    [workspaceId, path],
  );
  const file = useMemo<HostedPreviewFile>(() => {
    const fileName = fileBaseName(path);
    const absolutePath = resolveWorkspacePath(workspacePath, path);
    const tree = workspaceBackend(projectId).tree;
    const workspace = isExternal ? undefined : { projectId, workspaceId };
    return {
      kind: 'file',
      fileName,
      mimeType: mimeTypeFromName(fileName) ?? 'application/octet-stream',
      sizeBytes: 0,
      source: {
        kind: 'hosted',
        key: `${workspaceId}:${path}@${revision}`,
        read: () => readBytes(projectId, workspaceId, path),
        registerHtml: (documentHtml) => registerHtmlPreview(documentHtml, (content) => workspaceRpc(projectId).files.createPreview(projectId, workspaceId, absolutePath, content)),
        quote: (selection) => quoteWorkspaceFile(projectId, sessionId, path, selection),
        // On another machine this computer's programs cannot reach it: it is downloaded instead.
        ...(tree.download ? {} : { openExternal: () => void openPathWithFailureToast(absolutePath, workspace) }),
        download: () => {
          if (tree.download && !isExternal) {
            void tree.download({ projectId, workspaceId, rootPath: workspacePath ?? '', files: null }, { path, name: fileName, kind: 'file' });
            return;
          }
          void readBytes(projectId, workspaceId, path).then(async (blob) => {
            const { downloadBlob } = await import('@/lib/download');
            downloadBlob(blob, fileName);
          });
        },
      },
    };
  }, [projectId, workspaceId, sessionId, workspacePath, path, isExternal, revision]);
  return <MessageFilePreview fill tabbed file={file} onClose={onClose} />;
}
