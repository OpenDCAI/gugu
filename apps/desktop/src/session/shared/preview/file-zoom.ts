import type { WindowMenuCommand } from '../../../../shared/window-menu-commands';

export type FileZoomCommand = Extract<WindowMenuCommand, 'zoomIn' | 'zoomOut' | 'resetZoom'>;
export const FILE_ZOOM_ATTRIBUTE = 'data-file-content-zoom';
export const FILE_ZOOM_EVENT = 'gugu:file-content-zoom';
export const isFileZoomCommand = (command: unknown): command is FileZoomCommand =>
  command === 'zoomIn' || command === 'zoomOut' || command === 'resetZoom';

/** Main uses only the focused viewer in its own window; no App or hidden page is addressed. */
export function fileZoomScript(command: FileZoomCommand): string {
  return `(() => {
    const target = document.activeElement?.closest('[${FILE_ZOOM_ATTRIBUTE}]');
    if (!target || !target.checkVisibility()) return false;
    const detail = { command: ${JSON.stringify(command)}, handled: false };
    target.dispatchEvent(new CustomEvent('${FILE_ZOOM_EVENT}', { detail }));
    return detail.handled;
  })()`;
}
