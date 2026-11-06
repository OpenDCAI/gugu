import { useEffect, useMemo, useState } from 'react';
import { MessageFilePreview, type HostedPreviewFile } from '@/components/chat/MessageFilePreview';
import { downloadBlob } from '@/lib/download';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { registerHtmlPreview } from '@/components/preview/html-preview-registration';
import { mimeTypeFromName } from '@gugu/core/shared/imageMime.mjs';
import { quoteWorkspaceFile } from '@renderer/lib/editor/quote-workspace-file';
import { fileChangesChannel } from '@shared/core/fs/fsEvents';
import { workspaceBackend, workspaceEvents, workspaceRpc } from '../workspace-backend/workspace-backend';
import { openPathWithFailureToast } from '../stores/open-file-in-file-editor';
import { fileBaseName } from '../stores/workspace-path';
import { OpenWithSystemButton } from './open-with-system-button';

async function readBytes(projectId: string, workspaceId: string, path: string): Promise<Blob> {
  const result = await workspaceRpc(projectId).files.readInlineBinary(projectId, workspaceId, path);
  if (!result.success) throw new Error('message' in result.error ? result.error.message : String(result.error));
  if (!result.data.success) throw new Error(result.data.error);
  return (await fetch(result.data.dataUrl)).blob();
}

/**
 * A file of a workspace in the preview a chat's file opens in: its bytes through that workspace (whichever machine it is
 * on), read again when the file changes there. A session's file tab and an App's peek both draw this.
 */
export function WorkspaceFileView({ projectId, workspaceId, sessionId, path, absolutePath, inWorkspace, rootPath, onClose }: {
  projectId: string;
  workspaceId: string;
  /** Quoting a selection goes to this session's draft; none (a project's folder): nothing to quote into. */
  sessionId?: string;
  path: string;
  absolutePath: string;
  /** Inside the workspace, main also lets the system open it outside home. */
  inWorkspace: boolean;
  rootPath: string;
  onClose: () => void;
}) {
  const { translate } = useSessionMessages();
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
    const tree = workspaceBackend(projectId).tree;
    const download = () => {
      if (tree.download && inWorkspace) void tree.download({ projectId, workspaceId, rootPath, files: null }, { path, name: fileName, kind: 'file' });
      else void readBytes(projectId, workspaceId, path).then((blob) => downloadBlob(blob, fileName));
    };
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
        quote: (selection) => sessionId ? quoteWorkspaceFile(projectId, sessionId, path, selection) : Promise.resolve(),
        // On another machine this computer's programs cannot reach it: it is downloaded instead.
        ...(tree.download ? {} : { openExternal: () => void openPathWithFailureToast(absolutePath, inWorkspace ? { projectId, workspaceId } : undefined) }),
        // On this computer the system's program takes it; from another machine it is downloaded (outside the workspace there: read back here).
        unreadableAction: tree.download
          ? <Button size="sm" variant="outline" className="mt-4" onClick={download}>{translate('file.downloadInstead')}</Button>
          : <OpenWithSystemButton absolutePath={absolutePath} {...(inWorkspace ? { workspace: { projectId, workspaceId } } : {})} />,
        download,
      },
    };
  }, [projectId, workspaceId, sessionId, path, absolutePath, inWorkspace, rootPath, revision, translate]);
  return <MessageFilePreview fill tabbed readOnly={!sessionId} file={file} onClose={onClose} />;
}
