/** Existing same-frame snapshot event, shared by file viewers and editable content. */
export const CONTENT_MENU_EVENT = 'gugu:file-viewer-menu';

export type HistoryAction = 'undo' | 'redo';
export type EditorMenuHistory = Record<HistoryAction, boolean>;
export interface ContentMenuSnapshot {
  action: 'snapshot';
  editorHistory?: EditorMenuHistory;
}
export type ContentMenuRequest = ContentMenuSnapshot | { action: HistoryAction };
