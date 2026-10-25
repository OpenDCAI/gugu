/** The native file menu addresses the viewer that was right-clicked, including App pages. */
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
}
