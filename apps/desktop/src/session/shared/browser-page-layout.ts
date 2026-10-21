/**
 * 量页签里那张网页的排版(browser-page-fit.ts 的「装进面板」兜底用):它有没有 viewport meta、100% 下自己要多宽。
 * 量是在网页自己的进程里量 —— 网页是主进程持有的 view,主进程替页签跑这段、把结果带回去。
 *
 * · 返回 **JSON 字符串**:`executeJavaScript` 只保证带得回可结构化克隆的值。
 * · 隔**两帧**再量:调用方可能刚把缩放拨回 100%,而排版发生在网页自己的渲染进程里 ——
 *   这边 await 一下并不代表那边已经重排完。量早了会量到上一次缩放下的宽度。
 */
export const BROWSER_PAGE_MEASURE_SCRIPT = `new Promise(function (resolve) {
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      resolve(JSON.stringify({
        hasViewportMeta: !!document.querySelector('meta[name="viewport" i]'),
        layoutWidthPx: Math.max(
          document.documentElement ? document.documentElement.scrollWidth : 0,
          document.body ? document.body.scrollWidth : 0
        )
      }));
    });
  });
})`;

export type BrowserPageLayout = {
  hasViewportMeta: boolean;
  layoutWidthPx: number;
};

/** 量回来的那串 JSON → 排版;形状不对就当没量到(null)。 */
export function parseBrowserPageLayout(raw: unknown): BrowserPageLayout | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as Partial<BrowserPageLayout>;
    if (typeof parsed.hasViewportMeta !== 'boolean') return null;
    if (typeof parsed.layoutWidthPx !== 'number' || !Number.isFinite(parsed.layoutWidthPx)) return null;
    return { hasViewportMeta: parsed.hasViewportMeta, layoutWidthPx: parsed.layoutWidthPx };
  } catch {
    return null;
  }
}
