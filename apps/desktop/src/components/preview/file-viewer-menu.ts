import {
  FILE_VIEWER_ATTRIBUTE,
  FILE_VIEWER_MENU_EVENT,
  type FileViewerMenuRequest,
  type FileViewerEditAction,
  type FileViewerSelection,
} from '@/session/shared/preview/file-viewer-menu';

export interface FileViewerSnapshot {
  quote: (selection: FileViewerSelection | null) => Promise<void> | void;
  selection?: FileViewerSelection;
  selectAll?: () => void;
  canSelectAll?: boolean;
  edit?: (action: FileViewerEditAction) => void;
  editable?: boolean;
  enabled?: FileViewerMenuRequest['enabled'];
}

/** A single binding per viewer; callbacks and editor selections are captured before the menu takes focus. */
export function bindFileViewerMenu(
  element: HTMLElement,
  snapshot: () => FileViewerSnapshot,
  onError: (error: unknown) => void,
): () => void {
  const id = crypto.randomUUID();
  let pending: { requestId: string; snapshot: FileViewerSnapshot } | null = null;
  element.setAttribute(FILE_VIEWER_ATTRIBUTE, id);
  const receive = (event: Event) => {
    const detail = (event as CustomEvent<FileViewerMenuRequest>).detail;
    if (detail.action === 'snapshot') {
      const current = snapshot();
      pending = { requestId: detail.requestId, snapshot: current };
      if (current.selection) detail.selection = current.selection;
      if (current.canSelectAll !== undefined) detail.canSelectAll = current.canSelectAll;
      detail.customSelectAll = Boolean(current.selectAll);
      detail.customEditing = Boolean(current.edit);
      if (current.editable !== undefined) detail.editable = current.editable;
      if (current.enabled) detail.enabled = { ...detail.enabled, ...current.enabled };
      return;
    }
    if (!pending || pending.requestId !== detail.requestId) return;
    const captured = pending.snapshot;
    pending = null;
    if (detail.action === 'select-all') {
      captured.selectAll?.();
      return;
    }
    if (detail.action === 'undo' || detail.action === 'redo' || detail.action === 'cut' || detail.action === 'paste') {
      captured.edit?.(detail.action);
      return;
    }
    try {
      void Promise.resolve(captured.quote(detail.action === 'quote-selection' ? detail.selection : null)).catch(onError);
    } catch (error) {
      onError(error);
    }
  };
  element.addEventListener(FILE_VIEWER_MENU_EVENT, receive);
  return () => {
    pending = null;
    element.removeEventListener(FILE_VIEWER_MENU_EVENT, receive);
    if (element.getAttribute(FILE_VIEWER_ATTRIBUTE) === id) element.removeAttribute(FILE_VIEWER_ATTRIBUTE);
  };
}
