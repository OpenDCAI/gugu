/**
 * 查看面板里的双指缩放(#6456):**只缩放内容本身,不缩放界面**(#669 定过)。
 *
 * Chromium 把 mac 触控板的捏合交给页面时,是一串**带 `ctrlKey` 的 wheel 事件**(张开 = `deltaY < 0`
 * = 放大);普通双指滑动不带 `ctrlKey`,照常滚动。Electron 默认关掉了浏览器自己的捏合缩放
 * (visual zoom),而主窗口不能整体打开 —— 那会连界面一起缩放。所以要缩放的内容(图片、PDF、
 * 网页预览)各自接这串事件,换算统一在这里;浏览器面板的 `<webview>` 是独立客体,直接开它自己的
 * 原生捏合(`BROWSER_PINCH_MAX_LEVEL`)。
 *
 * 这个文件会被主进程(经 `preview-link-script.ts`)引到,❌ 只放纯函数和常量,不碰 DOM / React。
 */

/** 每单位 `deltaY` 缩放多少:一次捏合的 deltaY 通常是几到几十,指数换算让张开和合拢对称。 */
export const PINCH_ZOOM_SENSITIVITY = 0.01;

/** 网页预览与 PDF 的缩放范围(相对于默认排版)。 */
export const DOCUMENT_MIN_ZOOM = 0.5;
export const DOCUMENT_MAX_ZOOM = 4;

/** 浏览器面板 `<webview>` 原生捏合的上限(Electron `setVisualZoomLevelLimits` 的 maximumLevel)。 */
export const BROWSER_PINCH_MAX_LEVEL = 3;

/** 图片至少能放到原图的这个倍数:长图缩进窗格后字只有一指宽,放不到原图大小就等于看不清。 */
export const IMAGE_MIN_MAX_SCALE = 2;
/** 图片最多放到「适合窗格」的这个倍数(小图原本就清楚,再大没有意义)。 */
export const IMAGE_MAX_FIT_MULTIPLE = 8;

export function isPinchWheel(event: { ctrlKey: boolean }): boolean {
  return event.ctrlKey;
}

export function clampZoom(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 一步捏合之后的缩放:按手势等比放大或缩小,落在 [min, max] 里。 */
export function pinchZoom(current: number, deltaY: number, min: number, max: number): number {
  return clampZoom(current * Math.exp(-deltaY * PINCH_ZOOM_SENSITIVITY), min, max);
}

/**
 * 把图片整张放进窗格要用的比例(相对原图像素)。只缩不放:比窗格小的图按原大显示,
 * 与改之前 `max-w-full max-h-full` 的「适合窗格」一致。
 */
export function imageFitScale(
  natural: { width: number; height: number },
  box: { width: number; height: number }
): number {
  if (natural.width <= 0 || natural.height <= 0 || box.width <= 0 || box.height <= 0) return 1;
  return Math.min(1, box.width / natural.width, box.height / natural.height);
}

/** 图片能放到的最大比例:至少原图的 `IMAGE_MIN_MAX_SCALE` 倍,至多适合窗格的 `IMAGE_MAX_FIT_MULTIPLE` 倍。 */
export function imageMaxScale(fitScale: number): number {
  return Math.max(IMAGE_MIN_MAX_SCALE, fitScale * IMAGE_MAX_FIT_MULTIPLE);
}

/**
 * 指针落在图片上的相对位置(0..1;指针在图外时贴到最近的边)。缩放前记下它,缩放后用
 * `anchorScrollDelta` 把图片上同一点挪回指针下。
 *
 * ⚠️ 必须按图片**实际画在哪**(`getBoundingClientRect`)来算,❌ 按「滚动位置 + 指针」当内容坐标:
 * 图片在某个方向没铺满窗格时是居中的,那一侧的留白会随缩放一起变,那条算法会让图在指针下跳走。
 */
export function pointerFraction(pointer: number, start: number, size: number): number {
  if (size <= 0) return 0;
  return Math.min(1, Math.max(0, (pointer - start) / size));
}

/**
 * 缩放之后该再滚多少,才能让图片上 `fraction` 那一点回到指针下。`start`/`size` 是缩放后图片
 * 在这个方向上的实际位置与长度。滚不动的方向(图片还没超出窗格、居中着)由浏览器自己夹住。
 */
export function anchorScrollDelta(start: number, size: number, fraction: number, pointer: number): number {
  return start + fraction * size - pointer;
}
