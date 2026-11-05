import { useCallback, useEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import { clampZoom, DOCUMENT_MAX_ZOOM, DOCUMENT_MIN_ZOOM, isPinchWheel, pinchZoom } from '@/session/shared/preview/pinch-zoom';
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

/** Native menus and page keys share the same viewer command, owned by actual focus. `apply` returning false leaves it to the window. */
export function bindFileZoom(element: HTMLElement, apply: (command: FileZoomCommand) => boolean | void): () => void {
  element.setAttribute(FILE_ZOOM_ATTRIBUTE, '');
  const command = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (!isFileZoomCommand(detail?.command)) return;
    detail.handled = apply(detail.command) !== false;
  };
  const key = (event: KeyboardEvent) => {
    if (!(event.target instanceof Node) || !element.contains(event.target)) return;
    if (event.defaultPrevented || event.isComposing || !(event.metaKey || event.ctrlKey) || event.altKey) return;
    const command = event.key === '0' ? 'resetZoom' : event.key === '+' || event.key === '=' ? 'zoomIn' : event.key === '-' ? 'zoomOut' : null;
    if (!command || apply(command) === false) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const focus = (event: PointerEvent) => {
    const target = event.target as HTMLElement;
    if (!target.closest('input, textarea, select, button, a, iframe, [contenteditable="true"]')) element.focus({ preventScroll: true });
  };
  const oldTabIndex = element.getAttribute('tabindex');
  if (oldTabIndex === null) element.tabIndex = -1;
  element.addEventListener(FILE_ZOOM_EVENT, command);
  // Window capture: the focused viewer owns its zoom keys before app hotkeys, which also listen in capture (code editor bridge, captured commands).
  const view = element.ownerDocument.defaultView ?? window;
  view.addEventListener('keydown', key, true);
  element.addEventListener('pointerdown', focus);
  return () => {
    element.removeEventListener(FILE_ZOOM_EVENT, command);
    view.removeEventListener('keydown', key, true);
    element.removeEventListener('pointerdown', focus);
    element.removeAttribute(FILE_ZOOM_ATTRIBUTE);
    if (oldTabIndex === null) element.removeAttribute('tabindex');
  };
}

export function zoomForCommand(current: number, command: FileZoomCommand): number {
  return command === 'resetZoom' ? 1 : current * (command === 'zoomIn' ? 1.2 : 1 / 1.2);
}

/**
 * Code editor: font size follows the text/code preference, and a pinch over the editor steps that preference
 * (one write per frame) instead of zooming the whole window.
 */
export function bindEditorFileZoom(container: HTMLElement, setFontSize: (px: number) => void, baseFontSize: number): () => void {
  const apply = () => setFontSize(baseFontSize * readFileZoom('text-code'));
  const offPreference = subscribeFileZoom(apply);
  const offCommand = bindFileZoom(container, command => writeFileZoom('text-code', clampZoom(zoomForCommand(readFileZoom('text-code'), command), DOCUMENT_MIN_ZOOM, DOCUMENT_MAX_ZOOM)));
  let pendingDeltaY = 0;
  let frame = 0;
  const flush = () => {
    frame = 0;
    writeFileZoom('text-code', pinchZoom(readFileZoom('text-code'), pendingDeltaY, DOCUMENT_MIN_ZOOM, DOCUMENT_MAX_ZOOM));
    pendingDeltaY = 0;
  };
  const wheel = (event: WheelEvent) => {
    if (!isPinchWheel(event)) return;
    event.preventDefault();
    event.stopPropagation();
    pendingDeltaY += event.deltaY;
    if (!frame) frame = requestAnimationFrame(flush);
  };
  container.addEventListener('wheel', wheel, { capture: true, passive: false });
  apply();
  return () => {
    offPreference();
    offCommand();
    container.removeEventListener('wheel', wheel, { capture: true });
    if (frame) cancelAnimationFrame(frame);
  };
}

export function useFileZoom(kind: FileZoomKind, ref: RefObject<HTMLElement | null>, onCommand?: (command: FileZoomCommand) => boolean | void) {
  const zoom = useSyncExternalStore(subscribeFileZoom, () => readFileZoom(kind), () => 1);
  const applyRef = useRef(onCommand);
  applyRef.current = onCommand;
  // Bound to the element actually mounted, not to [ref, kind]: a reused panel moves its ref between files of the same kind.
  const bound = useRef<{ element: HTMLElement | null; kind: FileZoomKind; off?: () => void }>(undefined);
  useEffect(() => {
    const element = ref.current;
    if (bound.current?.element === element && bound.current.kind === kind) return;
    bound.current?.off?.();
    bound.current = {
      element,
      kind,
      off: element ? bindFileZoom(element, command => {
        if (applyRef.current) return applyRef.current(command);
        writeFileZoom(kind, clampZoom(zoomForCommand(readFileZoom(kind), command), DOCUMENT_MIN_ZOOM, DOCUMENT_MAX_ZOOM));
      }) : undefined,
    };
  });
  useEffect(() => () => { bound.current?.off?.(); bound.current = undefined; }, []);
  const setZoom = useCallback((value: number | ((current: number) => number)) => writeFileZoom(kind, typeof value === 'function' ? value(readFileZoom(kind)) : value), [kind]);
  return { zoom, setZoom };
}
