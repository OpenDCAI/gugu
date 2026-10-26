import { randomUUID } from 'node:crypto';
import { BrowserWindow, clipboard, type App, type ContextMenuParams, type WebContents } from 'electron';
import { showContentContextMenu } from './content-context-menu';
import { FILE_VIEWER_ATTRIBUTE, FILE_VIEWER_MENU_EVENT, type FileViewerMenuAction, type FileViewerMenuRequest, type FileViewerMenuLabels, fileViewerMenuItems } from '../src/session/shared/preview/file-viewer-menu';

type Context = FileViewerMenuRequest & { viewerId: string };

/** Native points use window coordinates; a webview's DOM hit test uses its local coordinates. */
export function viewerContextScript(params: Pick<ContextMenuParams, 'x' | 'y' | 'isEditable'>, requestId: string, selection: FileViewerMenuRequest['selection'], offset = { x: 0, y: 0 }): string {
  return `(() => {
    const root=document.elementFromPoint(${params.x - offset.x},${params.y - offset.y})?.closest('[${FILE_VIEWER_ATTRIBUTE}]');
    if (!root) return null;
    const detail=${JSON.stringify({ action: 'snapshot', requestId, selection, canSelectAll: true, editable: params.isEditable })};
    root.dispatchEvent(new CustomEvent(${JSON.stringify(FILE_VIEWER_MENU_EVENT)},{detail}));
    return {...detail,viewerId:root.getAttribute('${FILE_VIEWER_ATTRIBUTE}')};
  })()`;
}

export function viewerActionScript(context: Context, action: FileViewerMenuAction): string {
  return `(() => {
    const root=[...document.querySelectorAll('[${FILE_VIEWER_ATTRIBUTE}]')].find(e=>e.getAttribute('${FILE_VIEWER_ATTRIBUTE}')===${JSON.stringify(context.viewerId)});
    if (!root) return false;
    root.dispatchEvent(new CustomEvent(${JSON.stringify(FILE_VIEWER_MENU_EVENT)},{detail:${JSON.stringify({ ...context, action })}}));
    return true;
  })()`;
}

export function registerFileViewerMenus(app: App, labels: () => FileViewerMenuLabels, report: (error: unknown) => void): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('context-menu', (_menuEvent, params) => {
      void showFileViewerMenu(contents, params, labels(), report).catch(report);
    });
  });
}

async function showFileViewerMenu(contents: WebContents, params: ContextMenuParams, labels: FileViewerMenuLabels, report: (error: unknown) => void): Promise<void> {
  const frame = params.frame;
  if (!frame || contents.isDestroyed()) return;
  const offset = contents.hostWebContents
    ? await contents.hostWebContents.mainFrame.executeJavaScript(`(() => { const view=[...document.querySelectorAll('webview')].find(view=>view.getWebContentsId()===${contents.id});return view?.getBoundingClientRect().toJSON(); })()`) as { x: number; y: number } | undefined
    : { x: 0, y: 0 };
  if (!offset) return;
  const context = await contents.mainFrame.executeJavaScript(viewerContextScript(params, randomUUID(), { text: params.selectionText }, offset)) as Context | null;
  if (!context) return;
  const run = (action: FileViewerMenuAction | 'copy') => {
    if (contents.isDestroyed()) return;
    const perform = async () => {
      if (action === 'copy') { await clipboard.writeText(context.selection.text); return; }
      if (action === 'select-all' && !context.customSelectAll) {
        const root = frame === contents.mainFrame
          ? `[...document.querySelectorAll('[${FILE_VIEWER_ATTRIBUTE}]')].find(e=>e.getAttribute('${FILE_VIEWER_ATTRIBUTE}')===${JSON.stringify(context.viewerId)})`
          : 'document.body';
        await frame.executeJavaScript(`(() => { const root=${root};if(!root)return;const range=document.createRange();range.selectNodeContents(root.querySelector('[data-file-selection]')||root);const s=getSelection();s.removeAllRanges();s.addRange(range); })()`, true);
        return;
      }
      if (!context.customEditing && (action === 'undo' || action === 'redo' || action === 'cut' || action === 'paste')) {
        contents[action]();
        return;
      }
      await contents.mainFrame.executeJavaScript(viewerActionScript(context, action), true);
    };
    void perform().catch(report);
  };
  showContentContextMenu(fileViewerMenuItems(context, labels, run), {
    window: BrowserWindow.fromWebContents(contents.hostWebContents ?? contents) ?? undefined,
    x: params.x,
    y: params.y,
  });
}
