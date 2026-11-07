import { useEffect, useMemo, useState } from 'react';
import { MessageFilePreview, type HostedPreviewFile } from '@/components/chat/MessageFilePreview';
import { downloadBlob } from '@/lib/download';
import { messageForUser } from '@/lib/userFacingError';
import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import type { OpenInAppId } from '@shared/openInApps';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { downloadSessionFile } from '@renderer/features/remote-hosts/workspace/remote-file-actions';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { registerHtmlPreview } from '@/components/preview/html-preview-registration';
import { mimeTypeFromName } from '@gugu/core/shared/imageMime.mjs';
import { quoteWorkspaceFile } from '@renderer/lib/editor/quote-workspace-file';
import { fileChangesChannel } from '@shared/core/fs/fsEvents';
import { workspaceBackend, workspaceEvents, workspaceRpc } from '../workspace-backend/workspace-backend';
import { openPathWithFailureToast } from '../stores/open-file-in-file-editor';
import { fileBaseName } from '../stores/workspace-path';
import { getSessionView } from '../stores/session-selectors';
import { EDITOR_CONFIRM_FILE_BYTES } from '@renderer/lib/editor/file-size-limits';
import { getFileKind } from '@renderer/lib/editor/fileKind';
import { FOLDER_APP_FILE_TAB, openFolderInTab } from './file-view-kinds';
import { OpenWithSystemButton } from './open-with-system-button';

const isTextRead = (path: string) => ['text', 'markdown', 'html', 'csv'].includes(getFileKind(path));

/** Text comes as text and the rest as bytes: the inline read only takes image and document formats. */
async function readBytes(projectId: string, workspaceId: string, path: string, inWorkspace: boolean): Promise<Blob> {
  const files = workspaceRpc(projectId).files;
  if (isTextRead(path)) {
    const read = inWorkspace ? files.readFile : files.readExternalFile;
    const result = await read(projectId, workspaceId, path, EDITOR_CONFIRM_FILE_BYTES);
    if (!result.success) throw new Error('message' in result.error ? result.error.message : String(result.error));
    if (result.data.truncated) throw new Error(`File too large: ${result.data.totalSize} bytes`);
    return new Blob([result.data.content], { type: 'text/plain' });
  }
  const result = await files.readInlineBinary(projectId, workspaceId, path);
  if (!result.success) throw new Error('message' in result.error ? result.error.message : String(result.error));
  if (!result.data.success) throw new Error(result.data.error);
  return (await fetch(result.data.dataUrl)).blob();
}

/**
 * A file of a workspace in the preview a chat's file opens in: its bytes through that workspace (whichever machine it is
 * on), read again when the file changes there. A session's file tab and an App's peek both draw this.
 */
export function WorkspaceFileView({ root, tabId, projectId, workspaceId, sessionId, path, absolutePath, inWorkspace, onClose }: {
  /** The working copy's root: a folder of it in the path is a way to its list. */
  root?: string;
  /** The tab it is drawn in: editing goes to the folder App in this tab, and reading comes back to it. */
  tabId?: string;
  projectId: string;
  workspaceId: string;
  /** Quoting a selection goes to this session's draft; none (a project's folder): nothing to quote into. */
  sessionId?: string;
  path: string;
  absolutePath: string;
  /** Inside the workspace, main also lets the system open it outside home. */
  inWorkspace: boolean;
  onClose: () => void;
}) {
  const { translate } = useSessionMessages();
  const { toast } = useToast();
  // Asked of main: this view is drawn in the shell too, where the session page's settings queries are not.
  const [openInApps, setOpenInApps] = useState<{ id: OpenInAppId; label: string }[]>([]);
  useEffect(() => {
    if (workspaceBackend(projectId).elsewhere) return;
    let current = true;
    void (async () => {
      const apps = await rpc.app.openInMenu();
      if (current) setOpenInApps(apps);
    })().catch((error: unknown) => log.error('[file-view] open-in list', { error: String(error) }));
    return () => { current = false; };
  }, [projectId]);
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
    const { elsewhere } = workspaceBackend(projectId);
    const kind = getFileKind(path);
    const editable = !!sessionId && (kind === 'html' || kind === 'csv' || kind === 'svg');
    const download = () => {
      if (elsewhere && sessionId) void downloadSessionFile(sessionId, inWorkspace ? path : absolutePath, fileName);
      else void readBytes(projectId, workspaceId, path, inWorkspace).then((blob) => downloadBlob(blob, fileName)).catch((error: unknown) => toast({ title: translate('remoteFiles.downloadFailed', { name: fileName }), description: messageForUser(error), variant: 'destructive' }));
    };
    return {
      kind: 'file',
      fileName,
      mimeType: mimeTypeFromName(fileName) ?? 'application/octet-stream',
      sizeBytes: 0,
      source: {
        kind: 'hosted',
        key: `${workspaceId}:${path}@${revision}`,
        read: () => readBytes(projectId, workspaceId, path, inWorkspace),
        registerHtml: (documentHtml) => registerHtmlPreview(documentHtml, (content) => workspaceRpc(projectId).files.createPreview(projectId, workspaceId, absolutePath, content)),
        quote: (selection) => sessionId ? quoteWorkspaceFile(projectId, sessionId, path, selection) : Promise.resolve(),
        // On another machine this computer's programs cannot reach it: it is downloaded instead.
        ...(elsewhere ? {} : {
          openExternal: () => void openPathWithFailureToast(absolutePath, inWorkspace ? { projectId, workspaceId } : undefined),
          // 「用 VS Code、访达、终端打开」: this computer's programs, as the project tab's menu lists them.
          openIn: openInApps.map(({ id, label }) => ({
            key: id,
            label: translate('titlebar.openIn', { app: label }),
            open: () => void rpc.app.openIn({ app: id, path: absolutePath }).then((result) => { if (!result?.success) toast({ title: translate('titlebar.openInFailed', { app: label }), description: messageForUser(result?.error), variant: 'destructive' }); }),
          })),
        }),
        // On this computer the system's program takes it; from another machine it is downloaded (outside the workspace there: read back here).
        unreadableAction: elsewhere
          ? <Button size="sm" variant="outline" className="mt-4" onClick={download}>{translate('file.downloadInstead')}</Button>
          : <OpenWithSystemButton absolutePath={absolutePath} {...(inWorkspace ? { workspace: { projectId, workspaceId } } : {})} />,
        folders: absolutePath.split(/[\\/]/).slice(0, -1).map((name, index, parts) => {
          const here = parts.slice(0, index + 1).join('/');
          const inside = root !== undefined && sessionId && tabId && inWorkspace && (here === root || here.startsWith(`${root}/`));
          return inside ? { name, open: () => { const view = getSessionView(projectId, sessionId!); if (view) openFolderInTab(view.paneLayout, tabId, here.slice(root.length + 1)); } } : { name };
        }),
        ...(editable ? { edit: () => getSessionView(projectId, sessionId!)?.paneLayout.open(FOLDER_APP_FILE_TAB, { filePath: absolutePath }, { from: tabId ?? null, intent: 'navigate' }) } : {}),
        download,
      },
    };
  }, [root, tabId, projectId, workspaceId, sessionId, path, absolutePath, inWorkspace, revision, translate, toast, openInApps]);
  return <MessageFilePreview fill tabbed readOnly={!sessionId} file={file} onClose={onClose} />;
}
