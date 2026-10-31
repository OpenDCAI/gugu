// @@@scrollbar-autohide (#7641) — 让滚动条平时不可见、滚动时才浮出。
//
// 为什么需要 JS:`::-webkit-scrollbar` 一旦被定义,Blink 就把那个元素换成**经典**滚动条
// (常驻、占布局宽度) —— 这一条写在 styles/tokens.css 的同名注释里,是当初为桌面有意选的。
// 而 CSS 没有「正在滚动」这个状态(没有 :scrolling 伪类),`:hover` 只能近似:用触控板甩出去
// 的惯性滚动、或滚完把鼠标移开,鼠标都不在容器里,纯 hover 方案那时反而不显示。
//
// 所以由这里在滚动的元素上打一个 `data-scrolling` 属性,停下 HIDE_AFTER_MS 后摘掉,
// CSS 侧只认这个属性;鼠标留在容器内不会延长显示。
//
// ⚠️ `scroll` 事件**不冒泡**,必须 capture 才能在 document 上收到后代元素的滚动。
//    写成普通冒泡监听会一条都收不到 —— 而且不会报错,只是永远不生效。
// ⚠️ passive:true:这是只读监听,声明出来让浏览器不必等我们决定要不要 preventDefault。

const SCROLLING_ATTR = 'data-scrolling'
/** 停止滚动后再显示多久。短于 macOS 原生滚动条的淡出(~1s),长到足以跨过惯性滚动的间隙。 */
const HIDE_AFTER_MS = 800

export function installScrollbarAutoHide(
  target: Document = document,
  hideAfterMs: number = HIDE_AFTER_MS,
): () => void {
  // WeakMap:元素被移出 DOM 后连同它的计时器一起被回收,❌ 不要用 Map(那是一条按滚动次数增长的泄漏)
  const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>()

  const onScroll = (event: Event): void => {
    // 页面级滚动的 target 是 document 本身,它没有 setAttribute —— 那种情况交给根元素
    const node = event.target
    const element = node instanceof Element ? node : target.documentElement
    if (element === null) return

    if (!element.hasAttribute(SCROLLING_ATTR)) element.setAttribute(SCROLLING_ATTR, '')
    const previous = timers.get(element)
    if (previous !== undefined) clearTimeout(previous)
    timers.set(
      element,
      setTimeout(() => {
        element.removeAttribute(SCROLLING_ATTR)
        timers.delete(element)
      }, hideAfterMs),
    )
  }

  target.addEventListener('scroll', onScroll, { capture: true, passive: true })
  return () => target.removeEventListener('scroll', onScroll, { capture: true })
}
