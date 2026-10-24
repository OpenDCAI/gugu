import type { AppModalFocus, AppModalOptions } from '@/session/shared/extensions/app-modal';
import type { BrowserWebviewElement } from '@/session/renderer/features/browser/browser-webview-types';

export interface AppModalPresentation {
  id: string;
  title: string;
  appName: string;
  size: AppModalOptions['size'];
  url: string;
  partition?: string;
  frameName?: string;
  opener: HTMLElement;
  attach(element: BrowserWebviewElement | HTMLIFrameElement): () => void;
  focus(edge: AppModalFocus): void | Promise<void>;
  dismiss(error?: string): void | Promise<void>;
}
const MODAL_EVENT = 'gugu:app-modal';
export type AppModalEvent = { type: 'open'; presentation: AppModalPresentation } | { type: 'close' | 'focus-close'; id: string };

function dispatch(detail: AppModalEvent): void {
  const event = new CustomEvent(MODAL_EVENT, { detail, cancelable: true });
  if (window.dispatchEvent(event) && detail.type === 'open') throw new Error('No App modal host in this window');
}
export const showAppModal = (presentation: AppModalPresentation): void => dispatch({ type: 'open', presentation });
export const closeAppModal = (id: string): void => dispatch({ type: 'close', id });
export const focusAppModalClose = (id: string): void => dispatch({ type: 'focus-close', id });
export function listenAppModals(listener: (event: AppModalEvent) => void): () => void {
  const handler = (event: Event) => { event.preventDefault(); listener((event as CustomEvent<AppModalEvent>).detail); };
  window.addEventListener(MODAL_EVENT, handler);
  return () => window.removeEventListener(MODAL_EVENT, handler);
}
