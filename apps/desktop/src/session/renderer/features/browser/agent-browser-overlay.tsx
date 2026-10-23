import { observer } from 'mobx-react-lite';
import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { mirrorDocument } from '@renderer/lib/aux-document';
import { events, rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { agentOverlayWindowName, type AgentOverlayPart } from '@shared/aux-window';
import { browserAgentCursorChannel } from '@shared/events/browserEvents';
import { AgentBrowserCursor, skipAgentCursorMove } from './agent-browser-cursor';
import { agentBrowserState } from './agent-browser-state';

type Layer = { name: string; root: HTMLElement; release: () => void };
const BADGE_LAYER_PADDING = 8;

function openLayer(opener: Window, browserId: string, part: AgentOverlayPart): Layer | null {
  const name = agentOverlayWindowName(browserId, part);
  const win = opener.open('about:blank', name);
  if (!win) {
    log.warn('[agent-browser-overlay] could not open a page layer', { browserId, part });
    return null;
  }
  const doc = win.document;
  doc.title = 'agent';
  const stopMirror = mirrorDocument(opener.document, doc);
  for (const node of [doc.documentElement, doc.body]) {
    node.style.setProperty('background', 'transparent', 'important');
    node.style.setProperty('margin', '0');
    node.style.setProperty('overflow', 'hidden');
  }
  const skin = (opener as Window & { __EMDASH_MOUNT__?: HTMLElement }).__EMDASH_MOUNT__ ?? opener.document.querySelector('.gugu-skin');
  const root = doc.createElement('div');
  const syncSkin = () => { root.className = skin?.className ?? 'gugu-skin'; };
  syncSkin();
  const Observer = opener.document.defaultView?.MutationObserver ?? MutationObserver;
  const skinObserver = new Observer(syncSkin);
  if (skin) skinObserver.observe(skin, { attributes: true, attributeFilter: ['class'] });
  let sizeObserver: ResizeObserver | null = null;
  if (part === 'cursor') root.style.cssText = 'position:fixed;inset:0;background:transparent';
  else {
    doc.body.style.width = 'max-content';
    root.style.cssText = `display:inline-block;padding:${BADGE_LAYER_PADDING}px;background:transparent`;
    sizeObserver = new ResizeObserver(() => {
      const rect = root.getBoundingClientRect();
      doc.documentElement.style.width = `${Math.ceil(rect.width)}px`;
      doc.documentElement.style.height = `${Math.ceil(rect.height)}px`;
    });
    sizeObserver.observe(root);
  }
  doc.body.append(root);
  return { name, root, release: () => { sizeObserver?.disconnect(); skinObserver.disconnect(); stopMirror(); } };
}

function usePageLayer(browserId: string, hostElement: HTMLElement | null, enabled: boolean, part: AgentOverlayPart): Layer | null {
  const [layer, setLayer] = useState<Layer | null>(null);
  useLayoutEffect(() => {
    const opener = hostElement?.ownerDocument.defaultView;
    if (!enabled || !opener) return;
    const opened = openLayer(opener, browserId, part);
    if (!opened) return;
    setLayer(opened);
    return () => {
      setLayer(null);
      opened.release();
      // Main owns the native view; window.close() would close its whole app window.
      void rpc.browser.closeAgentOverlayLayers([opened.name]);
    };
  }, [browserId, enabled, hostElement, part]);
  return layer;
}

/** The shortcut belongs to the visible page, independently of transient Agent activity. */
export const AgentBrowserOverlay = observer(function AgentBrowserOverlay({ browserId, hostElement, visible, assistant }: {
  browserId: string;
  hostElement: HTMLElement | null;
  visible: boolean;
  assistant?: ReactNode;
}) {
  const cursor = usePageLayer(browserId, hostElement, visible && agentBrowserState(browserId) === 'driving', 'cursor');
  const badge = usePageLayer(browserId, hostElement, visible && Boolean(assistant), 'badge');
  useEffect(() => {
    if (cursor) return;
    return events.on(browserAgentCursorChannel, event => {
      if (event.browserId === browserId && event.kind === 'move') skipAgentCursorMove(event);
    });
  }, [browserId, cursor]);
  return <>
    {cursor ? createPortal(<AgentBrowserCursor browserId={browserId} visible={visible} />, cursor.root) : null}
    {badge ? createPortal(assistant, badge.root) : null}
  </>;
});
