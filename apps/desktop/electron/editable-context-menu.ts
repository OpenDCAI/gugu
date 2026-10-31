import { randomUUID } from 'node:crypto';
import type { ContextMenuParams, EditFlags, WebContents, WebFrameMain } from 'electron';
import { CONTENT_MENU_EVENT, type ContentMenuSnapshot, type HistoryAction } from '@gugu/session-shared/content-menu';
import { textContextMenuItems, type TextContextMenu, type TextEditAction } from '../src/session/shared/text-context-menu';
import { showContentContextMenu } from './content-context-menu';

export function editingEnabled(flags: EditFlags): TextContextMenu['enabled'] {
  return { undo: flags.canUndo, redo: flags.canRedo, cut: flags.canCut, copy: flags.canCopy, paste: flags.canPaste, selectAll: flags.canSelectAll };
}

/** Keep DOM references in their source frame; no input value crosses into the menu model. */
export function editableSnapshotScript(key: string): string {
  return `(() => {
    let element=document.activeElement;
    while (element?.shadowRoot?.activeElement) element=element.shadowRoot.activeElement;
    if (!(element instanceof HTMLElement) || !(element.isContentEditable || 'selectionStart' in element)) return false;
    const start=element.selectionStart,end=element.selectionEnd,direction=element.selectionDirection;
    const selection=getSelection();
    const range=element.isContentEditable && selection?.rangeCount && element.contains(selection.getRangeAt(0).commonAncestorContainer) ? selection.getRangeAt(0).cloneRange() : null;
    const snapshot={action:'snapshot'};
    element.dispatchEvent(new CustomEvent(${JSON.stringify(CONTENT_MENU_EVENT)},{detail:snapshot}));
    globalThis[${JSON.stringify(key)}]=(historyAction)=>{
      if (!element.isConnected) return false;
      element.focus({preventScroll:true});
      if (typeof start==='number') element.setSelectionRange(start,end,direction);
      else if (range) { const current=getSelection();current.removeAllRanges();current.addRange(range); }
      if (historyAction) {
        const command=new CustomEvent(${JSON.stringify(CONTENT_MENU_EVENT)},{detail:{action:historyAction},cancelable:true});
        element.dispatchEvent(command);
        if (!command.defaultPrevented) throw new Error('The editor history command is unavailable');
      }
      return true;
    };
    return {editorHistory:snapshot.editorHistory};
  })()`;
}

export async function captureEditableContext(contents: WebContents, frame: WebFrameMain, report: (error: unknown) => void) {
  const key = `gugu:editable-menu:${randomUUID()}`;
  const snapshot = await frame.executeJavaScript(editableSnapshotScript(key)) as ContentMenuSnapshot | false;
  if (!snapshot) throw new Error('The editable menu target is unavailable');
  const restore = async (action?: HistoryAction) => {
    if (contents.isDestroyed() || frame.isDestroyed()) throw new Error('The editable menu source was closed');
    // Electron WebContents.focus() intentionally does nothing for guests; focus their embedding frame.
    const host = contents.hostWebContents;
    if (host) {
      if (!await host.mainFrame.executeJavaScript(`(() => { const view=[...document.querySelectorAll('webview')].find(view=>view.getWebContentsId()===${contents.id});if(!view)return false;view.focus();return true; })()`, true)) throw new Error('The editable menu guest was removed');
    } else contents.focus();
    if (!await frame.executeJavaScript(`globalThis[${JSON.stringify(key)}]?.(${JSON.stringify(action)})`, true)) throw new Error('The editable menu target was removed');
  };
  return {
    editorHistory: snapshot.editorHistory ? { enabled: snapshot.editorHistory, undo: () => restore('undo'), redo: () => restore('redo') } : undefined,
    run: async (action: TextEditAction) => {
      await restore();
      contents[action]();
    },
    close: () => {
      if (!frame.isDestroyed()) void frame.executeJavaScript(`delete globalThis[${JSON.stringify(key)}]`).catch(report);
    },
  };
}

export async function showEditableContextMenu(contents: WebContents, params: ContextMenuParams, position: Parameters<typeof showContentContextMenu>[1], report: (error: unknown) => void, labels?: TextContextMenu['labels']): Promise<void> {
  if (!params.frame) return;
  const captured = await captureEditableContext(contents, params.frame, report);
  showContentContextMenu(textContextMenuItems({
    labels, selectionText: params.selectionText, enabled: editingEnabled(params.editFlags), editorHistory: captured.editorHistory,
    actions: {
      undo: () => captured.run('undo'), redo: () => captured.run('redo'),
      cut: () => captured.run('cut'), copy: () => captured.run('copy'), paste: () => captured.run('paste'), selectAll: () => captured.run('selectAll'),
    },
  }), position, captured.close);
}
