import { textContextMenuItems, type TextContextMenu } from '../text-context-menu';
import type { ContentMenuEntry } from '../content-context-menu';

/** The host file menu addresses the viewer that was right-clicked, including App pages. */
export const FILE_VIEWER_ATTRIBUTE = 'data-gugu-file-viewer';
export const FILE_VIEWER_MENU_EVENT = 'gugu:file-viewer-menu';

export interface FileViewerSelection {
  text: string;
  at?: Record<string, string>;
}

export type FileViewerEditAction = 'undo' | 'redo' | 'cut' | 'paste';
export type FileViewerMenuAction = 'quote-selection' | 'quote-file' | 'select-all' | FileViewerEditAction;

export interface FileViewerMenuRequest {
  action: 'snapshot' | FileViewerMenuAction;
  requestId: string;
  selection: FileViewerSelection;
  canSelectAll: boolean;
  customSelectAll?: boolean;
  customEditing?: boolean;
  editable?: boolean;
  enabled?: TextContextMenu['enabled'];
}

export interface FileViewerMenuLabels {
  copy: string;
  selectAll: string;
  quoteSelection: string;
  quoteFile: string;
  undo: string;
  redo: string;
  cut: string;
  paste: string;
}

export function fileViewerMenuItems(context: FileViewerMenuRequest, labels: FileViewerMenuLabels, run: (action: FileViewerMenuAction | 'copy') => void | Promise<void>) {
  const options: TextContextMenu = {
    labels, selectionText: context.selection.text, canSelectAll: context.canSelectAll, enabled: context.enabled,
    actions: { copy: () => run('copy'), selectAll: () => run('select-all'), ...(context.editable ? {
      undo: () => run('undo'), redo: () => run('redo'), cut: () => run('cut'), paste: () => run('paste'),
    } : {}) },
  };
  const extra: ContentMenuEntry[] = [
    { id: 'quote-selection', icon: 'quote', label: labels.quoteSelection, enabled: context.selection.text.length > 0, click: () => run('quote-selection') },
    { id: 'quote-file', icon: 'file', label: labels.quoteFile, click: () => run('quote-file') },
  ];
  return textContextMenuItems(options, extra);
}
