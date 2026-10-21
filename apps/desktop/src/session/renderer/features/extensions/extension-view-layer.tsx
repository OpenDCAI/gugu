import { observer } from 'mobx-react-lite';
import { reaction } from 'mobx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import type { BrowserWebviewElement } from '@renderer/features/browser/browser-webview-types';
import { extensionSurfaceStore } from './extension-surface-store';
import { extensionViewStore, type ExtensionViewClaim } from './extension-view-store';
import { installedExtensionsStore } from './installed-extensions-store';
import { listenForAppSlots } from './app-slot-events';
import { AppSettingsPage } from './app-settings-page';
import { ExtensionGuestBinding } from './extension-guest-binding';

/**
 * 常驻扩展的页都住在这一层:每个 App 在每个地方(一个群、一个任务)一张,一生不换地方(摩擦单 F48,
 * extension-view-store)。
 *
 * 挂在会话页的根上(App.tsx),不挂在 Workspace 里:聊天页打开「新建 Agent」时会话页切到
 * composer 视图,Workspace 整棵卸载,挂在它里面的页会跟着销毁(L3 第 3 步;报告 5 §1.5)。
 * 落点不止会话格:dock、群右栏也向同一张页认领(extension-view-store 的认领栈)。
 *
 * 为什么不放在会话页的树里:内嵌网页在页面树里换个位置就会整页重载。要做到
 * 「切会话那一格纹丝不动」(behavior tab-extensions),页就得住在会话树之外、由宿主
 * 把它摆到当前会话那一格的位置上 —— 切会话只是挪一下、告诉它现在给谁看,不重建。
 *
 * 一格都没在屏上时页藏起来但活着(后台那份状态本来也不靠它),因为下一次它要**立刻**出现,
 * 而不是再准备一次。但它只在**第一次有格要它**时才建(从入口打开、以后的 dock):
 * ❌ 装好就起一张谁也没要的隐藏页(摩擦单 F3)。
 *
 * 群右栏「用 X 打开」一个文件不用这张共享页:每次打开都新建一张绑着这个文件的页,页的一生
 * 不换文件,返回 / 关掉就没了。拿共享页去接文件,接到的是一张早就开机、没有文件、开机那次
 * `files.open(…)` 早已失败的页(F3 实测:timeOrigin 是装好的时刻)。
 */
export const ExtensionViewLayer = observer(function ExtensionViewLayer() {
  const layerRef = useRef<HTMLDivElement | null>(null);
  // Slots outside the session page (a group's side panel) claim through a window event.
  useEffect(() => listenForAppSlots(), []);
  // Switched off or removed: its shared page goes, and switched on again it waits to be wanted.
  useEffect(
    () =>
      reaction(
        () => installedExtensionsStore.residentTabContributions.map((contribution) => contribution.kind),
        (now, before) => {
          for (const kind of before) if (!now.includes(kind)) extensionViewStore.forgetOpened(kind);
        }
      ),
    []
  );
  const contributions = installedExtensionsStore.residentTabContributions;
  const enabled = new Map<string, (typeof contributions)[number]>(
    contributions.map((contribution) => [contribution.kind, contribution])
  );
  return (
    <div
      ref={layerRef}
      data-slot="extension-view-layer"
      className="pointer-events-none fixed inset-0 z-30"
    >
      {[...extensionViewStore.residentPages.values()].map((page) => {
        const contribution = enabled.get(page.kind);
        return contribution ? (
          <ExtensionPage
            key={page.key}
            kind={page.kind}
            extensionId={contribution.extensionId}
            layerRef={layerRef}
            pageKey={page.key}
            managed={contribution.hostSettings}
          />
        ) : null;
      })}
      {[...extensionViewStore.filePages].map(([token, filePage]) => {
        const contribution = enabled.get(filePage.kind);
        return contribution ? (
          <ExtensionPage
            key={`file:${token}`}
            kind={filePage.kind}
            extensionId={contribution.extensionId}
            layerRef={layerRef}
            fileToken={token}
            itemId={filePage.claim.itemId}
          />
        ) : null;
      })}
    </div>
  );
});

/** Following a claimed slot's box after it appears: until it holds still this many frames, or this long. */
const FOLLOW_STILL_FRAMES = 10;
const FOLLOW_MAX_MS = 2_000;

interface Surface {
  partition: string;
  entryUrl: string;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

function intersect(a: Box, b: Box): Box {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function rectOf(element: Element): Box {
  const r = element.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/**
 * 认领方的一格在屏上占的框,以及它**实际露出来**的那部分。
 *
 * 两个框都要:面板收起时是把宽度压到 0 再 overflow-hidden,里面那一格的布局框还是 320 宽 ——
 * 只看它自己的框,页会画在一个早已被裁掉的位置上。所以沿祖先把每一层 overflow 不是 visible
 * 的框都交一遍,得到真正可见的区域;页按露出的区域裁,内容按整格的框摆,不变形。
 * 两边都按视口量,再换算到本层坐标,祖先有 transform 也不歪。
 */
function boxOf(element: HTMLElement, layer: HTMLElement): { full: Box; clip: Box } {
  const l = rectOf(layer);
  const full = rectOf(element);
  let clip: Box = intersect(full, l);
  let node: Node | null = element.parentNode;
  while (node && clip.width > 0 && clip.height > 0) {
    if (node instanceof Element) {
      const cs = getComputedStyle(node);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') clip = intersect(clip, rectOf(node));
    }
    node = node instanceof ShadowRoot ? node.host : node.parentNode;
  }
  const toLayer = (b: Box): Box => ({
    left: Math.round(b.left - l.left),
    top: Math.round(b.top - l.top),
    width: Math.round(b.width),
    height: Math.round(b.height),
  });
  return { full: toLayer(full), clip: toLayer(clip) };
}

/** 从那一格往上到文档根的每一层(穿过 shadow root):任何一层的尺寸一变,格的位置都可能变。 */
function ancestorsOf(element: HTMLElement): Element[] {
  const out: Element[] = [];
  let node: Node | null = element;
  while (node) {
    if (node instanceof Element) out.push(node);
    const parent: Node | null = node.parentNode;
    node = parent instanceof ShadowRoot ? parent.host : parent;
  }
  return out;
}

/**
 * One App page in the layer. With `pageKey` it is the App's page for one place (a group, a task) and
 * follows whichever slot of that place claims it now (`claims`); with `fileToken`, it is the page opened
 * for one file and follows that one claim (`filePages`) — bound to it at its first dom-ready, never retargeted.
 */
const ExtensionPage = observer(function ExtensionPage({
  kind,
  extensionId,
  layerRef,
  pageKey,
  fileToken,
  itemId,
  managed = false,
}: {
  kind: string;
  extensionId: string;
  layerRef: React.RefObject<HTMLDivElement | null>;
  pageKey?: string;
  fileToken?: number;
  itemId?: string;
  managed?: boolean;
}) {
  const claimOf = useCallback(
    () =>
      fileToken === undefined
        ? pageKey === undefined
          ? undefined
          : extensionViewStore.claims.get(pageKey)
        : extensionViewStore.filePages.get(fileToken)?.claim,
    [fileToken, pageKey]
  );
  const [surface, setSurface] = useState<Surface | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  /** 整格大小的那层,在裁剪框里按偏移摆;webview 填满它。 */
  const innerRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<BrowserWebviewElement | null>(null);
  const guestReadyRef = useRef<BrowserWebviewElement | null>(null);
  const [guestBinding] = useState(() => new ExtensionGuestBinding({
    bind: (webContentsId, target) => rpc.extensions.bindSurface({ ...target, webContentsId, extensionId, tabKind: kind }),
    retarget: (webContentsId, target) => rpc.extensions.retargetSurface({ ...target, webContentsId }),
  }));
  const guestTeardownRef = useRef<(() => void) | null>(null);
  /** 页此刻登记在哪一格名下(仅为了切走时把那一格的登记清掉)。 */
  const registeredRef = useRef<{ sessionId: string | null; tabId: string } | null>(null);
  /** 上一位认领方那一格的观察者;换格或卸载时先拆。 */
  const teardownRef = useRef<(() => void) | null>(null);
  const lastReportRef = useRef<string>('');
  /** 每次指向的序号:A→B→A 快速切换时,晚落地的 B 那次不许再往登记表里写。 */
  const aimSeqRef = useRef(0);

  useEffect(() => {
    if (managed) return;
    let disposed = false;
    setSurface(null);
    void rpc.extensions
      .activate({ extensionId, tabKind: kind })
      .then((result) => {
        if (disposed) return;
        if (result.success && result.data) setSurface(result.data);
        else log.warn('Extension activation failed:', result.error);
      })
      .catch((error: unknown) => {
        if (!disposed) log.warn('Extension activation failed:', error);
      });
    return () => {
      disposed = true;
    };
  }, [extensionId, kind, managed]);

  /** 尺寸与可见性报给桥(它会去重);没绑定时无处可报,静默。 */
  const report = useCallback((visible: boolean, width: number, height: number) => {
    const webContentsId = guestBinding.boundWebContentsId;
    if (webContentsId === null || guestReadyRef.current !== webviewRef.current) return;
    const key = `${visible}:${width}:${height}`;
    if (key === lastReportRef.current) return;
    lastReportRef.current = key;
    void rpc.extensions
      .reportLayout({ webContentsId, visible, width, height })
      .catch((error: unknown) => log.warn('Failed to report extension surface layout:', error));
  }, [guestBinding]);

  /** 把页交给此刻的认领方:第一次是 bind,之后每换一格是 retarget。没有认领方就只记账。 */
  const aimAt = useCallback(
    (claim: ExtensionViewClaim | undefined) => {
      if (managed) {
        if (claim) extensionViewStore.setHostPageReady(claim.token);
        return;
      }
      const webview = webviewRef.current;
      if (!webview || guestReadyRef.current !== webview) return;
      const seq = ++aimSeqRef.current;
      const previous = registeredRef.current;
      if (previous && (!claim || previous.sessionId !== (claim.sessionId ?? null) || previous.tabId !== claim.tabId)) {
        extensionSurfaceStore.setWebContentsId(previous.sessionId, previous.tabId, null);
        registeredRef.current = null;
      }
      if (!claim) return;
      const target = {
        // A group's side panel is in no task: the binding says so by leaving it out.
        ...(claim.sessionId ? { sessionId: claim.sessionId } : {}),
        tabId: claim.tabId,
        ...(claim.chatId ? { chatId: claim.chatId } : {}),
        ...(claim.itemId ? { itemId: claim.itemId } : {}),
      };
      void guestBinding.aim(target)
        .then((result) => {
          if (!result) return;
          if (!result.success) {
            log.warn('Extension surface binding refused:', result.error);
            return;
          }
          const { webContentsId } = result;
          // The slot that claimed it can now reach this page (its header's toolbar / menu, 摩擦单 F13).
          extensionViewStore.setSurface(claim.token, webContentsId);
          // 这期间又指向别处了:登记表归最新那次管,这次的落地只算 bind 成功,别的不写。
          if (seq !== aimSeqRef.current) return;
          // Where its chrome (title / badge / error, the toolbar's commands) finds it: by the slot's session, none for a
          // slot in no session (a group's panel, the rail's page before any session).
          registeredRef.current = { sessionId: claim.sessionId ?? null, tabId: claim.tabId };
          extensionSurfaceStore.setWebContentsId(claim.sessionId ?? null, claim.tabId, webContentsId);
          // bind 之前的尺寸汇报都无处可去;现在补一次,让页第一帧就按真实宽度排版。
          lastReportRef.current = '';
          const layer = layerRef.current;
          if (layer) {
            const { full, clip } = boxOf(claim.element, layer);
            report(clip.width > 0 && clip.height > 0 && document.visibilityState === 'visible', full.width, full.height);
          }
        })
        .catch((error: unknown) => {
          log.warn('Extension surface binding failed:', error);
        });
    },
    [guestBinding, layerRef, report, managed]
  );

  const attachWebview = useCallback(
    (element: BrowserWebviewElement | null) => {
      guestTeardownRef.current?.();
      guestTeardownRef.current = null;
      webviewRef.current = element;
      guestReadyRef.current = null;
      guestBinding.reset();
      ++aimSeqRef.current;
      if (!element) return;
      const ready = () => {
        if (webviewRef.current !== element || !element.isConnected) return;
        // Read the id only at this guest's dom-ready, never from a delayed
        // binding reply after Electron has already replaced the guest (#7514).
        guestBinding.ready(element.getWebContentsId());
        guestReadyRef.current = element;
        aimAt(claimOf());
      };
      // guest 崩了:旧的 webContents id 作废,绑定也作废。重载一次,dom-ready 会再来一遍、重新 bind;
      // ❌ 不能留着一个死 id 等下一次认领去 retarget —— 那只会换来一条 warn 和一格永远的空白。
      const gone = () => {
        if (webviewRef.current !== element) return;
        log.warn('Extension surface render process gone; reloading', { kind });
        guestReadyRef.current = null;
        guestBinding.reset();
        ++aimSeqRef.current;
        registeredRef.current = null;
        element.reload();
      };
      element.addEventListener('dom-ready', ready);
      element.addEventListener('render-process-gone', gone);
      guestTeardownRef.current = () => {
        element.removeEventListener('dom-ready', ready);
        element.removeEventListener('render-process-gone', gone);
      };
    },
    [aimAt, claimOf, guestBinding, kind]
  );

  // 认领方一换(切会话 / 换 tab / 聊天栏换会话)→ 重新指向 + 重新摆位。
  useEffect(
    () =>
      reaction(
        () => claimOf(),
        (claim) => aimAt(claim),
        { fireImmediately: true }
      ),
    [aimAt, claimOf]
  );

  // 摆位与尺寸汇报:跟着认领方那一格走;一格都没有就藏起来。
  useEffect(
    () =>
      reaction(
        () => claimOf(),
        (claim) => {
          teardownRef.current?.();
          teardownRef.current = null;
          const box = boxRef.current;
          const layer = layerRef.current;
          if (!box || !layer) return;
          if (!claim) {
            box.style.visibility = 'hidden';
            if (managed) box.style.opacity = '0';
            box.inert = true;
            report(false, 0, 0);
            return;
          }
          const place = () => {
            const { full, clip } = boxOf(claim.element, layer);
            const shown =
              clip.width > 0 &&
              clip.height > 0 &&
              claim.element.isConnected &&
              claim.element.checkVisibility({ visibilityProperty: true, opacityProperty: true });
            box.style.left = `${clip.left}px`;
            box.style.top = `${clip.top}px`;
            box.style.width = `${clip.width}px`;
            box.style.height = `${clip.height}px`;
            box.style.visibility = shown ? 'visible' : 'hidden';
            if (managed) box.style.opacity = shown ? '1' : '0';
            box.inert = !shown;
            const inner = innerRef.current;
            if (inner) {
              inner.style.left = `${full.left - clip.left}px`;
              inner.style.top = `${full.top - clip.top}px`;
              inner.style.width = `${full.width}px`;
              inner.style.height = `${full.height}px`;
            }
            report(shown && document.visibilityState === 'visible', full.width, full.height);
          };
          place();
          // A slot that slides in (a side panel's enter animation) moves by transform, which no
          // ResizeObserver, resize or scroll reports: measured once, the page stayed drawn where the
          // slot was mid-slide (desktop #6802 D1). So follow it frame by frame until its box has
          // held still for a few frames — bounded, for a slot that never settles.
          let frame = 0;
          const followUntil = performance.now() + FOLLOW_MAX_MS;
          let lastBox = '';
          let still = 0;
          const follow = () => {
            place();
            const r = claim.element.getBoundingClientRect();
            const box = `${r.left},${r.top},${r.width},${r.height}`;
            still = box === lastBox ? still + 1 : 0;
            lastBox = box;
            frame = still < FOLLOW_STILL_FRAMES && performance.now() < followUntil ? requestAnimationFrame(follow) : 0;
          };
          frame = requestAnimationFrame(follow);
          const observer = new ResizeObserver(place);
          // Hidden in place by a class or style above it (a slot covered by what opens beside its page, AppPeekSlot) moves no
          // box: the page is told to hide by the change itself.
          const restyled = new MutationObserver(place);
          for (const node of ancestorsOf(claim.element)) {
            observer.observe(node);
            restyled.observe(node, { attributes: true, attributeFilter: ['style', 'class', 'hidden', 'inert'] });
          }
          window.addEventListener('resize', place);
          document.addEventListener('scroll', place, true);
          document.addEventListener('visibilitychange', place);
          teardownRef.current = () => {
            if (frame) cancelAnimationFrame(frame);
            observer.disconnect();
            restyled.disconnect();
            window.removeEventListener('resize', place);
            document.removeEventListener('scroll', place, true);
            document.removeEventListener('visibilitychange', place);
          };
        },
        { fireImmediately: true }
      ),
    // surface 进依赖:页的框(boxRef)要等激活之后才渲染出来,而那时认领方可能早就在了 ——
    // 不重订这条反应,它就停在「fireImmediately 那次没框可摆」上,直到下一次切会话才醒。
    [claimOf, layerRef, report, surface, managed]
  );

  useEffect(
    () => () => {
      teardownRef.current?.();
      // 常驻页没了(扩展停用 / 卸载 / 最久没用被销毁):它说过的话一起清掉,再开从清单标题重新开始。
      // 为文件开的页走了不算:那些话是常驻页的。
      if (pageKey !== undefined) extensionSurfaceStore.forgetShared(pageKey);
    },
    [pageKey]
  );

  if (!surface && !managed) return null;
  const manifest = installedExtensionsStore.manifestFor(extensionId);
  return (
    <div
      ref={boxRef}
      className="pointer-events-auto absolute overflow-hidden bg-background"
      style={{ visibility: 'hidden', opacity: managed ? 0 : undefined, left: 0, top: 0, width: 0, height: 0 }}
      data-extension-view={kind}
      data-extension-item={itemId}
    >
      <div ref={innerRef} className="absolute" style={{ left: 0, top: 0, width: 0, height: 0 }}>
        {managed && manifest ? <AppSettingsPage key={`${manifest.version}:${JSON.stringify(manifest.settings)}`} manifest={manifest} active={claimOf() !== undefined} /> : surface ? <webview
          key={`${extensionId}:${surface.partition}`}
          ref={attachWebview}
          src={surface.entryUrl}
          partition={surface.partition}
          className="h-full w-full bg-background"
        /> : null}
      </div>
    </div>
  );
});
