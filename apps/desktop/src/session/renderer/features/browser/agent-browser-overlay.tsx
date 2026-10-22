import { observer } from 'mobx-react-lite';
import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { mirrorDocument } from '@renderer/lib/aux-document';
import { events, rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { agentOverlayWindowName, type AgentOverlayPart } from '@shared/aux-window';
import { browserAgentCursorChannel } from '@shared/events/browserEvents';
import { AgentBrowserCursor, skipAgentCursorMove } from './agent-browser-cursor';
import { AgentBrowserBadge, agentBrowserState } from './agent-browser-state';

type Layer = { name: string; root: HTMLElement; release: () => void };

/** 小条那层四周留给阴影的透明边(主进程摆小条时扣掉同样的量,browser-page-views.ts BADGE_BOTTOM_GAP)。 */
const BADGE_LAYER_PADDING = 8;

/** 每开一层名字都不一样(请主进程关的是哪一层,说得清)。 */
let layerSequence = 0;

/**
 * 开一层(同源空白页,主进程把它装进那扇窗里叠在网页上面的一层 view)、把主窗的样式抄过去、整层透明,交回画东西的根节点。
 * 小条那层的大小跟着内容走(主进程读 preferred size):文档写成内容那么大,否则 preferred size 会把旧视口当成下限、缩不回去。
 * 不要了由主进程关(closeAgentOverlayLayers):❌ win.close() —— Electron 的 window.close 关的是这份内容所在的那扇窗,
 * 也就是整扇咕咕窗口(electron/window-layers.ts)。
 */
function openLayer(opener: Window, browserId: string, part: AgentOverlayPart): Layer | null {
  const name = agentOverlayWindowName(browserId, part, ++layerSequence);
  const win = opener.open('about:blank', name);
  if (!win) {
    log.warn('[agent-browser-overlay] the overlay layer could not be opened', { browserId, part });
    return null;
  }
  const doc = win.document;
  doc.title = 'agent';
  const stopMirror = mirrorDocument(opener.document, doc);
  // 整层透明:只有鼠标和小条有颜色(主题里给 html / body 上的底色一律压掉)。
  for (const node of [doc.documentElement, doc.body]) {
    node.style.setProperty('background', 'transparent', 'important');
    node.style.setProperty('margin', '0');
    node.style.setProperty('overflow', 'hidden');
  }
  const skinSource =
    (opener as Window & { __EMDASH_MOUNT__?: HTMLElement }).__EMDASH_MOUNT__ ?? opener.document.querySelector('.gugu-skin');
  const root = doc.createElement('div');
  root.className = skinSource?.className ?? 'gugu-skin';
  let sizeObserver: ResizeObserver | null = null;
  if (part === 'cursor') {
    root.style.cssText = 'position:fixed;inset:0;background:transparent';
  } else {
    doc.body.style.setProperty('width', 'max-content');
    root.style.cssText = `display:inline-block;padding:${BADGE_LAYER_PADDING}px;background:transparent`;
    sizeObserver = new ResizeObserver(() => {
      const box = root.getBoundingClientRect();
      doc.documentElement.style.width = `${Math.ceil(box.width)}px`;
      doc.documentElement.style.height = `${Math.ceil(box.height)}px`;
    });
    sizeObserver.observe(root);
  }
  doc.body.append(root);
  return {
    name,
    root,
    release: () => {
      sizeObserver?.disconnect();
      stopMirror();
    },
  };
}

/**
 * #7274 / #77 agent 的鼠标与「agent 正在操作」小条,画在那扇窗里叠在网页上面的两层里(主进程 window-layers.ts):网页是画在
 * 界面之上的独立 view,界面里的元素盖不住它;层和窗口是一体的,窗口看得见它们就看得见,❌ 另开子窗。
 * 小条那层只有小条那么大;鼠标那层铺满网页,只在画鼠标(agent 在操作)时露出。层的位置由主进程跟着网页那一块摆。
 * 界面同一个渲染进程,鼠标、小条还是原来那两个组件,只是画进这两层。
 *
 * 只在 agent 用着这个页签(在操作 / 人接管了)、页签在屏上时开着;别的时候关掉。
 */
export const AgentBrowserOverlay = observer(function AgentBrowserOverlay({
  browserId,
  hostElement,
  visible,
}: {
  browserId: string;
  /** 页签里那块网页占位:层从它所在的那扇窗里开出来(挪去单独成窗时,层跟着开在那扇窗里)。 */
  hostElement: HTMLElement | null;
  visible: boolean;
}) {
  const engaged = visible && agentBrowserState(browserId) !== 'idle';
  const [layers, setLayers] = useState<{ cursor: Layer; badge: Layer } | null>(null);

  useLayoutEffect(() => {
    const opener = hostElement?.ownerDocument.defaultView;
    if (!engaged || !opener) return;
    const cursor = openLayer(opener, browserId, 'cursor');
    const badge = openLayer(opener, browserId, 'badge');
    const close = () => {
      const opened = [cursor, badge].filter((layer): layer is Layer => layer !== null);
      for (const layer of opened) layer.release();
      if (opened.length) void rpc.browser.closeAgentOverlayLayers(opened.map((layer) => layer.name));
    };
    if (!cursor || !badge) {
      close();
      return;
    }
    setLayers({ cursor, badge });
    return () => {
      setLayers(null);
      close();
    };
  }, [browserId, engaged, hostElement]);

  // 层没开着(页签不在屏上):没有鼠标可飞,agent 的每一步当场回「到了」(开着时由层里的鼠标回)。
  useEffect(() => {
    if (layers) return;
    return events.on(browserAgentCursorChannel, (event) => {
      if (event.browserId === browserId && event.kind === 'move') skipAgentCursorMove(event);
    });
  }, [browserId, layers]);

  if (!layers) return null;
  return (
    <>
      {createPortal(<AgentBrowserCursor browserId={browserId} visible={visible} />, layers.cursor.root)}
      {createPortal(<AgentBrowserBadge browserId={browserId} />, layers.badge.root)}
    </>
  );
});
