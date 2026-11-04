import { useCallback, useEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import { clampZoom, DOCUMENT_MAX_ZOOM, DOCUMENT_MIN_ZOOM } from '@/session/shared/preview/pinch-zoom';
import { FILE_ZOOM_ATTRIBUTE, FILE_ZOOM_EVENT, isFileZoomCommand, type FileZoomCommand } from '@/session/shared/preview/file-zoom';

export type FileZoomKind = 'markdown' | 'text-code' | 'html' | 'pdf' | 'image';
const CHANGED = 'gugu:file-zoom-preference';
const keyOf = (kind: FileZoomKind) => `gugu.file-content-zoom.${kind}`;

/** One local reading preference per type, shared by retained tabs and both renderer roots. */
export function readFileZoom(kind: FileZoomKind): number {
  const value = Number(localStorage.getItem(keyOf(kind)) ?? 1);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return kind === 'image' ? Math.max(1, value) : clampZoom(value, DOCUMENT_MIN_ZOOM, DOCUMENT_MAX_ZOOM);
}
export function writeFileZoom(kind: FileZoomKind, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value === readFileZoom(kind)) return;
  localStorage.setItem(keyOf(kind), String(value));
  window.dispatchEvent(new Event(CHANGED));
}
export const subscribeFileZoom = (listener: () => void) => {
  window.addEventListener(CHANGED, listener);
  window.addEventListener('storage', listener);
  return () => { window.removeEventListener(CHANGED, listener); window.removeEventListener('storage', listener); };
};

/** Native menus and page keys share the same viewer command, owned by actual focus. */
export function bindFileZoom(element: HTMLElement, apply: (command: FileZoomCommand) => void): () => void {
  element.setAttribute(FILE_ZOOM_ATTRIBUTE, '');
  const command = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (!isFileZoomCommand(detail?.command)) return;
    apply(detail.command);
    detail.handled = true;
  };
  const key = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || !(event.metaKey || event.ctrlKey) || event.altKey) return;
    const command = event.key === '0' ? 'resetZoom' : event.key === '+' || event.key === '=' ? 'zoomIn' : event.key === '-' ? 'zoomOut' : null;
    if (!command) return;
    event.preventDefault();
    event.stopPropagation();
    apply(command);
  };
  const focus = (event: PointerEvent) => {
    const target = event.target as HTMLElement;
    if (!target.closest('input, textarea, select, button, a, iframe, [contenteditable="true"]')) element.focus({ preventScroll: true });
  };
  const oldTabIndex = element.getAttribute('tabindex');
  if (oldTabIndex === null) element.tabIndex = -1;
  element.addEventListener(FILE_ZOOM_EVENT, command);
  element.addEventListener('keydown', key, true);
  element.addEventListener('pointerdown', focus);
  return () => {
    element.removeEventListener(FILE_ZOOM_EVENT, command);
    element.removeEventListener('keydown', key, true);
    element.removeEventListener('pointerdown', focus);
    element.removeAttribute(FILE_ZOOM_ATTRIBUTE);
    if (oldTabIndex === null) element.removeAttribute('tabindex');
  };
}

export function zoomForCommand(current: number, command: FileZoomCommand): number {
  return command === 'resetZoom' ? 1 : current * (command === 'zoomIn' ? 1.2 : 1 / 1.2);
}

export function useFileZoom(kind: FileZoomKind, ref: RefObject<HTMLElement | null>, onCommand?: (command: FileZoomCommand) => void) {
  const zoom = useSyncExternalStore(subscribeFileZoom, () => readFileZoom(kind), () => 1);
  const applyRef = useRef(onCommand);
  applyRef.current = onCommand;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return bindFileZoom(element, command => {
      if (applyRef.current) applyRef.current(command);
      else writeFileZoom(kind, clampZoom(zoomForCommand(readFileZoom(kind), command), DOCUMENT_MIN_ZOOM, DOCUMENT_MAX_ZOOM));
    });
  }, [ref, kind]);
  const setZoom = useCallback((value: number | ((current: number) => number)) => writeFileZoom(kind, typeof value === 'function' ? value(readFileZoom(kind)) : value), [kind]);
  return { zoom, setZoom };
}
