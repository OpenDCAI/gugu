import { useCallback, useEffect, useState } from 'react';
import type { PeekTarget } from '@shared/extensions/app-runtime-protocol';
import { OpenWithSystemButton } from '@renderer/features/sessions/editor/file-content-types';
import { workspaceRpc } from '@renderer/features/sessions/workspace-backend/workspace-backend';
import { rpc } from '@renderer/lib/ipc';
import { Markdown } from '@/components/markdown/Markdown';
import { DocumentFileRenderer } from '@renderer/lib/editor/document-file-renderer';
import { getFileKind, isOfficeKind } from '@renderer/lib/editor/fileKind';
import { HtmlPreviewFrame, type HtmlPreviewRegistration } from '@/components/preview/HtmlPreviewFrame';
import { createProtocolPreview } from '@/components/preview/html-preview-registration';
import { openBrowserUrlExternally } from '@renderer/features/browser/browser-toolbar-actions';
import { parseExtensionTabKind } from '@shared/extensions/manifest';
import { ExtensionTabPane } from './extension-tab-pane';
import { pickSessionOpener, type SessionOpener } from './open-with';

type LocalPeek = Extract<PeekTarget, { kind: 'local' }>;

/**
 * G1 A file of a folder on this computer beside an App's page: the App that claims it, as a click in a session's files
 * picks it (`pickSessionOpener`) — else the host's own reader, the one a session's file tab uses (PDF and Office, an HTML
 * page with what it links beside it, a markdown or text file as the chat's preview draws it); anything else goes to the
 * system's program. Nothing here is a second viewer.
 */
export function PeekLocalFile({ target, tabId }: { target: LocalPeek; tabId: string }) {
  const held = useHeldWorkspace(target);
  const [opener, setOpener] = useState<SessionOpener | null>(null);
  useEffect(() => {
    let live = true;
    void pickSessionOpener(target.path, target.ask).then((picked) => live && setOpener(picked));
    return () => {
      live = false;
    };
  }, [target.path, target.ask]);
  if (!opener || held === null) return null;
  if (held !== 'ready') return <Unread target={target} why={held} />;
  if ('tabKind' in opener) {
    const extensionId = parseExtensionTabKind(opener.tabKind)?.extensionId ?? opener.tabKind;
    return (
      <ExtensionTabPane
        extensionId={extensionId}
        tabKind={opener.tabKind}
        sessionId={'session' in target.place ? target.place.session : null}
        {...('project' in target.place ? { projectId: target.place.project } : {})}
        tabId={tabId}
        filePath={target.path}
      />
    );
  }
  if ('cancelled' in opener) return <Unread target={target} />;
  const kind = getFileKind(target.path);
  if (kind === 'pdf' || isOfficeKind(kind)) {
    return (
      <DocumentFileRenderer
        file={{ path: target.path }}
        kind={kind}
        projectId={target.projectId}
        workspaceId={target.workspaceId}
        openAction={<OpenWithSystemButton absolutePath={target.absolutePath} workspace={target} />}
      />
    );
  }
  if (kind === 'html') return <PeekHtml target={target} />;
  if (kind === 'markdown' || kind === 'text' || kind === 'csv') return <PeekText target={target} markdown={kind === 'markdown'} />;
  return <Unread target={target} />;
}

/**
 * A project's folder is read through its workspace, held while the file is shown — as the new-task panel holds it with no
 * session there (draft-workspace-panel). A session's is held by its session. 'ready', why not, or null while asking.
 */
function useHeldWorkspace(target: LocalPeek): 'ready' | string | null {
  const project = 'project' in target.place ? target.place.project : null;
  const { workspaceId } = target;
  const [held, setHeld] = useState<'ready' | string | null>(project ? null : 'ready');
  useEffect(() => {
    if (!project) return undefined;
    let disposed = false;
    let acquired = false;
    void (async () => {
      const opened = await rpc.projects.openProject(project);
      const result = opened.success ? await rpc.projects.acquireProjectWorkspace(project, workspaceId) : opened;
      if (!result.success) {
        if (!disposed) setHeld('message' in result.error ? result.error.message : result.error.type);
        return;
      }
      acquired = true;
      if (disposed) void rpc.projects.releaseProjectWorkspace(project, workspaceId);
      else setHeld('ready');
    })();
    return () => {
      disposed = true;
      if (acquired) void rpc.projects.releaseProjectWorkspace(project, workspaceId);
    };
  }, [project, workspaceId]);
  return held;
}

/** Its text, read the way a file tab reads it; a markdown file drawn as the chat's preview draws one (`Markdown`). */
function PeekText({ target, markdown }: { target: LocalPeek; markdown: boolean }) {
  const content = useFileText(target);
  if (content === null) return null;
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4" data-testid="app-peek-text">
      {markdown ? <Markdown trust="chat" density="comfortable" content={content} hardBreaks /> : <pre className="m-0 whitespace-pre-wrap break-words">{content}</pre>}
    </div>
  );
}

function useFileText({ projectId, workspaceId, path }: LocalPeek): string | null {
  const [content, setContent] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setContent(null);
    void workspaceRpc(projectId).files.readFile(projectId, workspaceId, path, 8 * 1024 * 1024).then((result) => {
      if (live) setContent(result.success ? result.data.content : '');
    });
    return () => {
      live = false;
    };
  }, [projectId, workspaceId, path]);
  return content;
}

function Unread({ target, why }: { target: LocalPeek; why?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center p-4 text-center text-sm text-foreground-muted">
      <p>{why ?? target.name}</p>
      <OpenWithSystemButton absolutePath={target.absolutePath} workspace={target} />
    </div>
  );
}

/** An HTML page as a session's file tab shows it (the preview protocol: what it links beside it loads); links leave to the browser. */
function PeekHtml({ target }: { target: LocalPeek }) {
  const { projectId, workspaceId, absolutePath } = target;
  const content = useFileText(target);
  const register = useCallback(
    async (documentHtml: string): Promise<HtmlPreviewRegistration> => {
      // The page is registered by where it is on this computer: what it links beside it is read from there.
      const result = await workspaceRpc(projectId).files.createPreview(projectId, workspaceId, absolutePath, documentHtml);
      if (result.success) return createProtocolPreview(result.data);
      return { ok: false, message: 'message' in result.error ? result.error.message : 'Preview unavailable' };
    },
    [projectId, workspaceId, absolutePath]
  );
  if (content === null) return null;
  // A link out of the page goes to the browser; one to a file beside it stays in the page's own folder, unopened here.
  const onLink = (href: string) => /^https?:\/\//i.test(href) && openBrowserUrlExternally(href);
  return <HtmlPreviewFrame fileName={target.name} rawContent={content} register={register} onLink={onLink} />;
}
