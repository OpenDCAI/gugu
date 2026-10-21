import { browserFitZoomFactor, BROWSER_DEFAULT_ZOOM_FACTOR } from '@shared/browser';
import { browserSessionStore } from './browser-session-store';
import type { BrowserPageLayout } from '@shared/browser-page-layout';
import type { BrowserPageHandle } from './browser-page-handle';

/**
 * 老式桌面页在窄面板里的兜底:把整幅页面缩进面板,而不是默默裁掉右边。
 *
 * ## 这是什么问题
 *
 * owner 2026-09-07 实机:「浏览器怎么超边了,网页只有一半」。实测(424px 的工作区面板,
 * CDP 直读内嵌页):
 *
 * | 站点 | `<meta name="viewport">` | 内容宽 vs 视口 |
 * |---|---|---|
 * | www.baidu.com | **没有** | 1250 vs 425 → 右边 2/3 被裁 |
 * | github.com | `width=device-width` | 425 vs 425 ✅ |
 * | developer.mozilla.org | `width=device-width, initial-scale=1.0` | 425 vs 425 ✅ |
 *
 * 所以内嵌页的视口一直是对的(`innerWidth` 425 = 宿主元素 424),排版也一直在重排 ——
 * 裁掉的是**没有 viewport meta 的页面**,它从没被告知怎么变窄,于是按自己的最小宽度排,
 * 谁比它窄谁就只能看见左边一截。把真 Chrome 窗口拉到 425px 打开百度,一模一样。
 *
 * ## 为什么用缩放
 *
 * 网页的 zoom 不只是把像素画小,它同时把**布局视口**按同样比例放大(实机:面板 424px,
 * zoom 0.5 → 内嵌页量到 innerWidth 850)。所以「缩到装得下」和手机浏览器打开老式桌面页是同一
 * 件事:给页面一个够宽的视口,再整体缩进面板。缩完 innerWidth 正好等于页面自己要的宽度,
 * 一步收敛,不会来回震。
 *
 * ## 三条边界
 *
 * · **只对没有 viewport meta 的页面动手**。判据 ❌ 不能是「内容比视口宽」:响应式页面里一段
 *   过宽的代码块、一张宽表格都会让 scrollWidth 溢出,按那个判据整页会被缩到看不清,而页面
 *   本身排得好好的。
 * · **用户调过缩放就再也不插手**(`zoomSource === 'user'`)。自动缩放要每页重算,用户定的要
 *   跨页保持 —— 两者的生命周期相反,所以必须分开记,见 BrowserZoomSource。
 * · **记住页面在 100% 下的原始宽度**,拖宽面板时按它重算,而不是就地再量一次:缩放会把布局
 *   视口一起放大,缩过之后量到的是「缩放后的页面」。只量一次、只存原始值,拖宽拖窄都回得去。
 */

export async function measureBrowserPageLayout(page: BrowserPageHandle): Promise<BrowserPageLayout | null> {
  try {
    return await page.measureLayout();
  } catch {
    // 网页可能在测量途中被导航走 / 崩掉。量不到就不缩 —— 这条兜底本来就是
    // 「能改善就改善」,❌ 不许因为它失败而影响页面的正常显示。
    return null;
  }
}

/**
 * 换页了:把**自动**缩放收回 100%,并作废上一页的布局宽度。
 *
 * 不收回的话,上一页算出来的 34% 会被 applySessionZoom 原样套到下一页 —— 而下一页多半是
 * 响应式的,那 34% 就成了平白无故的一张小图。用户自己调的缩放不动。
 */
export function resetAutoBrowserZoom(browserId: string, webview: BrowserPageHandle): void {
  const session = browserSessionStore.getSession(browserId);
  if (!session || session.zoomSource === 'user') return;
  browserSessionStore.updateSession(browserId, {
    zoomFactor: BROWSER_DEFAULT_ZOOM_FACTOR,
    pageLayoutWidthPx: null,
  });
  webview.setZoomFactor(BROWSER_DEFAULT_ZOOM_FACTOR);
}

/**
 * 按面板当前宽度把这一页缩到装得下。
 *
 * `remeasure` = 这一页刚加载完,要现量它的原始宽度;不传就是面板宽度变了(拖分隔条),
 * 用记住的原始宽度重算即可。
 */
export async function fitBrowserPageToPane(
  browserId: string,
  webview: BrowserPageHandle,
  options: { remeasure?: boolean } = {}
): Promise<void> {
  const session = browserSessionStore.getSession(browserId);
  if (!session || session.zoomSource === 'user') return;

  let pageLayoutWidthPx = session.pageLayoutWidthPx;
  // 这一页已经量过了就别再量。`did-stop-loading` 一次导航里**可能响多次**(子框架各自加载完),
  // 而重量之前要先把缩放拨回 100% —— 那会让已经装好的页面闪一下裁切态(实测约 50ms)。
  // 「量过没有」就绪于这个值:它在 did-navigate 时被清掉,所以每换一页必然重量一次。
  if (options.remeasure && pageLayoutWidthPx === undefined) {
    // 量之前一定先回到 100%:缩放会把布局视口一起放大,在缩过的状态下量到的是「缩放后的页面」,
    // 拿它去算下一次缩放就会一次比一次小。
    if (session.zoomFactor !== BROWSER_DEFAULT_ZOOM_FACTOR) {
      browserSessionStore.updateSession(browserId, { zoomFactor: BROWSER_DEFAULT_ZOOM_FACTOR });
      webview.setZoomFactor(BROWSER_DEFAULT_ZOOM_FACTOR);
    }
    const layout = await measureBrowserPageLayout(webview);
    // 有 viewport meta = 这一页自己会变窄,不该替它做主。量到了也不记 —— 记了下次拖宽面板
    // 就会拿它去缩一张本来好好的页面。
    if (!layout || layout.hasViewportMeta) return;
    pageLayoutWidthPx = layout.layoutWidthPx;
    browserSessionStore.updateSession(browserId, { pageLayoutWidthPx });
  }
  if (pageLayoutWidthPx === undefined) return;

  const paneWidthPx = webview.getBoundingClientRect().width;
  // 面板收起/隐藏时元素是 0 宽,这时候算出来的是「缩到 25%」。❌ 别在量不到宽度时下手 ——
  // 同一条闸分栏那边也有(side-panel-split.tsx 的 groupMeasured)。
  if (paneWidthPx <= 0) return;
  const fitted = browserFitZoomFactor({ paneWidthPx, pageLayoutWidthPx });
  // null = 装得下。此时要回到 100%(面板被拖宽了),而不是停在上一次缩出来的比例。
  const next = fitted ?? BROWSER_DEFAULT_ZOOM_FACTOR;
  // ⚠️ 必须重新读一次:上面可能已经改过这个会话,而 store 的每次更新都换一个新对象,
  // 手里那个 `session` 是旧的。
  if (next === browserSessionStore.getSession(browserId)?.zoomFactor) return;
  browserSessionStore.updateSession(browserId, { zoomFactor: next });
  webview.setZoomFactor(next);
}
