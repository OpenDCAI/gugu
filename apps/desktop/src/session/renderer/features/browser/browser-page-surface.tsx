import { useEffect, useRef } from 'react';
import { rendererLogger } from '@/lib/log';
import { events, rpc } from '@renderer/lib/ipc';
import { browserPageEventChannel, type BrowserPageMode } from '@shared/events/browserEvents';
import { agentBrowserState } from './agent-browser-state';
import { forgetPageFocus, guardHostFocus, notePageFocus } from './browser-host-focus';
import { BrowserPageHandle } from './browser-page-handle';
import { isBrowserPageOccluded, type PageRect } from './browser-page-occlusion';

const surfaceLog = rendererLogger('browser/page-surface');

/** 多久看一眼网页那一块上有没有浮层(见 browser-page-occlusion.ts)。 */
const OCCLUSION_CHECK_MS = 100;
/** 被浮层盖着、agent 又正在操作这张网页时,截图多久换一张(人看得见 agent 在干什么)。 */
const OCCLUDED_REFRESH_MS = 1_000;
/**
 * 窗口被挡住、锁屏时界面不再出帧(requestAnimationFrame 停了),位置照样要量、照样要报 ——
 * agent 这时候也可能在操作这张网页,网页得有正确的大小。帧停了就由这个间隔接着量。
 */
const FALLBACK_TICK_MS = 250;
/** 浮层压上来时先换上一张网页截图,最多等它这么久。 */
const SNAPSHOT_WAIT_MS = 250;

/**
 * #7274 页签里网页那一块:界面里只是一块占位,网页本身是主进程持有的 WebContentsView,摆在这一块的位置上
 * (browser-page-views.ts)。这里负责:
 * - 挂上 / 卸下时请主进程建 / 收那张网页(页签挪位置时主进程接着用原来那张,❌ 重新载入);
 * - 每一帧量这块占位在窗口里的位置报过去,网页跟着挪、跟着缩放;
 * - 页签不在屏上(切走、整条会话页藏起来)报 `background`;界面的浮层压上来报 `occluded`,这时占位上换成一张网页截图;
 * - 主进程报来的网页事件交给 handle(地址栏、前进后退据此更新)。
 */
export function BrowserPageSurface({
  browserId,
  partition,
  initialUrl,
  visible,
  onHandle,
}: {
  browserId: string;
  partition: string;
  /** 只在第一次建这张网页时用;之后换地址走 handle.loadURL。 */
  initialUrl: string;
  /** 页签此刻在屏上(激活的页签、会话页在屏上)。 */
  visible: boolean;
  onHandle: (handle: BrowserPageHandle | null) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const onHandleRef = useRef(onHandle);
  onHandleRef.current = onHandle;
  const initialUrlRef = useRef(initialUrl);

  useEffect(() => {
    const element = ref.current;
    const win = element?.ownerDocument.defaultView;
    if (!element || !win) return;
    guardHostFocus(win);
    const windowName = win.name ?? '';
    const handle = new BrowserPageHandle(browserId, element);
    let disposed = false;

    const stopEvents = events.on(browserPageEventChannel, (event) => {
      if (event.browserId !== browserId) return;
      if (event.type === 'focus' || event.type === 'blur') notePageFocus(browserId, windowName, event.type === 'focus');
      handle.apply(event);
    });

    // ---- 位置与样子:每帧量一次占位,变了才报(浮层每 OCCLUSION_CHECK_MS 看一次)。
    let lastSent = '';
    let frame = 0;
    let occluded = false;
    let lastOcclusionCheck = -Infinity;
    let snapshotToken = 0;
    let lastSnapshotAt = 0;
    let mounted = false;
    let pendingSnapshotReport: (() => void) | null = null;

    const report = (mode: BrowserPageMode, rect: PageRect | null) =>
      rpc.browser.layoutPage({
        browserId,
        windowName,
        mode,
        rect: rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null,
      });

    const showSnapshot = async (thenReport: (() => void) | null) => {
      const token = ++snapshotToken;
      if (thenReport) pendingSnapshotReport = thenReport;
      lastSnapshotAt = Date.now();
      // 截图等不来(网页正卡着、渲染进程刚换)也只等这么久:浮层不能一直被网页压着。
      // 超时只放行浮层;截图晚到时仍然显示,不能把迟到的真实画面丢掉。
      let timer = 0;
      const timeout = new Promise<void>((resolve) => { timer = win.setTimeout(resolve, SNAPSHOT_WAIT_MS); });
      const capture = rpc.browser.snapshotPage(browserId).then(({ dataUrl }) => {
        if (!disposed && token === snapshotToken && dataUrl) element.style.backgroundImage = `url("${dataUrl}")`;
      }).catch((error: unknown) => {
        if (!disposed) surfaceLog.error({ browserId, error }, 'the browser page snapshot could not be captured');
      });
      await Promise.race([capture, timeout]);
      win.clearTimeout(timer);
      if (disposed || token !== snapshotToken) return;
      const notify = pendingSnapshotReport;
      pendingSnapshotReport = null;
      notify?.();
    };

    const refreshLoadedSnapshot = () => {
      if (lastSent.startsWith('occluded:')) void showSnapshot(null);
    };
    handle.addEventListener('did-stop-loading', refreshLoadedSnapshot);

    let lastTickAt = 0;
    const onFrame = (now: number) => {
      frame = win.requestAnimationFrame(onFrame);
      tick(now);
    };
    const tick = (now: number) => {
      lastTickAt = now;
      if (!mounted) return;
      const box = element.getBoundingClientRect();
      const rect: PageRect = { left: box.left, top: box.top, width: box.width, height: box.height };
      const onScreen =
        visibleRef.current &&
        rect.width > 0 &&
        rect.height > 0 &&
        element.checkVisibility({ visibilityProperty: true, opacityProperty: true });
      if (onScreen && now - lastOcclusionCheck >= OCCLUSION_CHECK_MS) {
        lastOcclusionCheck = now;
        occluded = isBrowserPageOccluded(element, rect);
      }
      const mode: BrowserPageMode = !onScreen ? 'background' : occluded ? 'occluded' : 'shown';
      const key = `${mode}:${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}`;
      if (key !== lastSent) {
        // 初次挂载或从后台回来也可能已经有浮层:每次进入遮挡态都先换上截图,不能留下纯白占位。
        const enteringOcclusion = mode === 'occluded' && !lastSent.startsWith('occluded:');
        const wasShown = lastSent.startsWith('shown:');
        lastSent = key;
        if (enteringOcclusion) {
          if (wasShown) {
            // 先截一张、换上,再让网页收起 —— 收起在前,浮层压着的那块会白一下。
            void showSnapshot(() => { if (lastSent === key) void report(mode, rect); });
          } else {
            // 从没露过面的网页还没有尺寸:先摆好停放视图,再截图,否则主进程只能返回空图。
            void report(mode, rect).then(() => { if (lastSent === key) void showSnapshot(null); });
          }
        } else {
          if (mode !== 'occluded') {
            snapshotToken += 1;
            pendingSnapshotReport = null;
            element.style.backgroundImage = '';
          }
          void report(mode, rect);
        }
        return;
      }
      // 被盖着、agent 又在动它:截图隔一会儿换一张。
      if (mode === 'occluded' && agentBrowserState(browserId) === 'driving' && Date.now() - lastSnapshotAt >= OCCLUDED_REFRESH_MS) {
        void showSnapshot(null);
      }
    };

    void rpc.browser
      .mountPage({ browserId, partition, url: initialUrlRef.current, windowName })
      .then((result) => {
        if (disposed) return;
        if (!result.success) {
          surfaceLog.error({ browserId, error: result.error }, 'the browser page could not be created');
          return;
        }
        handle.mounted(result);
        mounted = true;
        onHandleRef.current(handle);
      });
    frame = win.requestAnimationFrame(onFrame);
    const fallback = win.setInterval(() => {
      const now = win.performance.now();
      if (now - lastTickAt >= FALLBACK_TICK_MS) tick(now);
    }, FALLBACK_TICK_MS);
    // 弹层挂到 body 上、拖拽开始 / 结束:当场看一眼,❌ 等下一个 OCCLUSION_CHECK_MS(菜单在网页底下晚出来一下,
    // 拖着的页签头一段指针落进网页、宿主收不到移动)。
    const doc = element.ownerDocument;
    const recheck = new MutationObserver(() => {
      lastOcclusionCheck = -Infinity;
      tick(win.performance.now());
    });
    recheck.observe(doc.body, { childList: true });
    recheck.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-gugu-dragging'] });

    return () => {
      disposed = true;
      recheck.disconnect();
      win.cancelAnimationFrame(frame);
      win.clearInterval(fallback);
      stopEvents();
      handle.removeEventListener('did-stop-loading', refreshLoadedSnapshot);
      forgetPageFocus(browserId);
      onHandleRef.current(null);
      void rpc.browser.releasePage(browserId);
    };
  }, [browserId, partition]);

  return (
    <div
      ref={ref}
      data-browser-page={browserId}
      // 点页签后焦点交给网页(pane-content 的内容聚焦器认这个标记):占位接住 focus、转给网页。
      tabIndex={-1}
      onFocus={() => void rpc.browser.pageCommand({ browserId, command: 'focus' })}
      className="h-full w-full bg-background bg-no-repeat outline-none"
      style={{ backgroundSize: '100% 100%' }}
    />
  );
}
