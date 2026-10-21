import { observer } from 'mobx-react-lite';
import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { mirrorDocument } from '@renderer/lib/aux-document';
import { events, rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { agentOverlayWindowName } from '@shared/aux-window';
import { browserAgentCursorChannel } from '@shared/events/browserEvents';
import { AgentBrowserCursor, skipAgentCursorMove } from './agent-browser-cursor';
import { AgentBrowserBadge, agentBrowserState } from './agent-browser-state';

/** 小条上能点的那一块带这个标记:人的鼠标指着它时,浮窗才接住点击(否则点击穿过浮窗落到网页上)。 */
export const AGENT_OVERLAY_INTERACTIVE_ATTRIBUTE = 'data-agent-overlay-interactive';

type Mounted = { win: Window; root: HTMLElement };

/**
 * #7274 agent 的鼠标与「agent 正在操作」小条,画在一扇盖在网页上的透明子窗里:网页是画在界面之上的独立 view
 * (browser-page-views.ts),界面里的元素盖不住它。这扇窗点不着、拿不到焦点(人点小条也不会把窗口焦点从聊天框拿走,
 * exp10 实测),位置由主进程跟着网页那一块摆。界面同一个渲染进程,鼠标、小条还是原来那两个组件,只是画进这扇窗。
 *
 * 只在 agent 用着这个页签(在操作 / 人接管了)、页签在屏上时开着;别的时候关掉,不多占一扇窗。
 */
export const AgentBrowserOverlay = observer(function AgentBrowserOverlay({
  browserId,
  hostElement,
  visible,
}: {
  browserId: string;
  /** 页签里那块网页占位:浮窗从它所在的那扇窗里开出来(挪去单独成窗时,浮窗跟着挂到那扇窗上)。 */
  hostElement: HTMLElement | null;
  visible: boolean;
}) {
  const engaged = visible && agentBrowserState(browserId) !== 'idle';
  const [mounted, setMounted] = useState<Mounted | null>(null);

  useLayoutEffect(() => {
    const opener = hostElement?.ownerDocument.defaultView;
    if (!engaged || !opener) return;
    const win = opener.open('about:blank', agentOverlayWindowName(browserId));
    if (!win) {
      log.warn('[agent-browser-overlay] the overlay window could not be opened', { browserId });
      return;
    }
    const doc = win.document;
    const stopMirror = mirrorDocument(opener.document, doc);
    // 整扇窗透明:只有鼠标和小条有颜色(主题里给 html / body 上的底色一律压掉)。
    for (const node of [doc.documentElement, doc.body]) {
      node.style.setProperty('background', 'transparent', 'important');
      node.style.setProperty('margin', '0');
      node.style.setProperty('overflow', 'hidden');
    }
    const skinSource =
      (opener as Window & { __EMDASH_MOUNT__?: HTMLElement }).__EMDASH_MOUNT__ ?? opener.document.querySelector('.gugu-skin');
    const root = doc.createElement('div');
    root.className = skinSource?.className ?? 'gugu-skin';
    root.style.cssText = 'position:fixed;inset:0;background:transparent';
    doc.body.append(root);

    // 人的鼠标指着小条上能点的那块时,浮窗接住点击;移开就让点击穿过去(主进程那边切换 setIgnoreMouseEvents)。
    let interactive = false;
    const onMove = (event: MouseEvent) => {
      const over = (event.target as Element | null)?.closest?.(`[${AGENT_OVERLAY_INTERACTIVE_ATTRIBUTE}]`) != null;
      if (over === interactive) return;
      interactive = over;
      void rpc.browser.setAgentOverlayInteractive({ browserId, interactive: over });
    };
    doc.addEventListener('mousemove', onMove);
    setMounted({ win, root });

    return () => {
      doc.removeEventListener('mousemove', onMove);
      stopMirror();
      setMounted(null);
      if (!win.closed) win.close();
    };
  }, [browserId, engaged, hostElement]);

  useEffect(() => {
    if (!mounted) return;
    mounted.win.document.title = 'agent';
  }, [mounted]);

  // 浮窗没开着(页签不在屏上):没有鼠标可飞,agent 的每一步当场回「到了」(开着时由浮窗里的鼠标回)。
  useEffect(() => {
    if (mounted) return;
    return events.on(browserAgentCursorChannel, (event) => {
      if (event.browserId === browserId && event.kind === 'move') skipAgentCursorMove(event);
    });
  }, [browserId, mounted]);

  if (!mounted) return null;
  return createPortal(
    <>
      <AgentBrowserCursor browserId={browserId} visible={visible} />
      <AgentBrowserBadge browserId={browserId} />
    </>,
    mounted.root
  );
});
