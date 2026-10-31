// @vitest-environment jsdom
// @@@scrollbar-autohide (#7641) — 滚动条平时透明、滚动时浮出。CSS 侧只认 `data-scrolling` 属性,
// 这里钉的是「谁来打这个属性、什么时候摘掉」。
//
// 显隐规则本身不在这里判(jsdom 不渲染滚动条,断言颜色等于自欺)。那一半由 Chromium headless 的
// 四格对照实测过:transparent thumb 不显示、带 [data-scrolling] 的显示、两框内容宽度一致不跳版。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import postcss from 'postcss'
import { installScrollbarAutoHide } from '../../../apps/desktop/src/lib/scrollbarAutoHide'

describe('@@@scrollbar-autohide (#7641) 滚动中标记', () => {
  let uninstall: (() => void) | null = null

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    uninstall?.()
    uninstall = null
    vi.useRealTimers()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  function scrollableDiv(): HTMLDivElement {
    const el = document.createElement('div')
    document.body.appendChild(el)
    return el
  }

  it('滚动时给那个元素打上标记', () => {
    uninstall = installScrollbarAutoHide(document, 800)
    const el = scrollableDiv()

    expect(el.hasAttribute('data-scrolling')).toBe(false)
    el.dispatchEvent(new Event('scroll', { bubbles: false }))
    expect(el.hasAttribute('data-scrolling')).toBe(true)
  })

  // ⚠️ 这条是整个模块最容易写错的地方:`scroll` **不冒泡**,监听不加 capture 就一条都收不到,
  //    而且不会报错 —— 只是滚动条永远不浮出。所以单独钉一条「事件不冒泡时也要收到」。
  it('scroll 不冒泡也要收到 —— 监听必须是 capture', () => {
    uninstall = installScrollbarAutoHide(document, 800)
    const outer = scrollableDiv()
    const inner = document.createElement('div')
    outer.appendChild(inner)

    inner.dispatchEvent(new Event('scroll', { bubbles: false }))
    expect(inner.hasAttribute('data-scrolling')).toBe(true)
  })

  it('停下之后摘掉标记', () => {
    uninstall = installScrollbarAutoHide(document, 800)
    const el = scrollableDiv()

    el.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(799)
    expect(el.hasAttribute('data-scrolling'), '799ms 就摘掉 = 滚动途中闪一下').toBe(true)
    vi.advanceTimersByTime(1)
    expect(el.hasAttribute('data-scrolling')).toBe(false)
  })

  it('连续滚动时不断续期,❌ 不能在第一次的计时到点时摘掉', () => {
    uninstall = installScrollbarAutoHide(document, 800)
    const el = scrollableDiv()
    const setAttribute = vi.spyOn(el, 'setAttribute')

    el.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(600)
    el.dispatchEvent(new Event('scroll')) // 又滚了一下
    vi.advanceTimersByTime(600)           // 距第一次已 1200ms,距最后一次才 600ms
    expect(el.hasAttribute('data-scrolling'), '没有续期 = 一直滚却中途消失').toBe(true)
    expect(setAttribute).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(200)
    expect(el.hasAttribute('data-scrolling')).toBe(false)
    el.dispatchEvent(new Event('scroll'))
    expect(setAttribute).toHaveBeenCalledTimes(2)
  })

  it('鼠标留在可滚动区域内,停滚后仍隐藏;CSS 只让滚动中的滑块显色', () => {
    uninstall = installScrollbarAutoHide(document, 800)
    const el = scrollableDiv()
    el.style.overflow = 'auto'
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    expect(el.hasAttribute('data-scrolling')).toBe(false)
    el.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(800)
    el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    expect(el.hasAttribute('data-scrolling')).toBe(false)

    // jsdom 不画伪元素:解析产品样式,枚举所有显色条件,防止容器 :hover 把祖先滚动条常亮。
    const backgrounds: Record<string, string> = {}
    postcss.parse(readFileSync('apps/desktop/src/styles/tokens.css', 'utf8')).walkRules((rule) => {
      if (!rule.selector.includes('::-webkit-scrollbar-thumb')) return
      rule.walkDecls('background', (declaration) => {
        for (const selector of rule.selectors) backgrounds[selector] = declaration.value
      })
    })
    expect(backgrounds).toEqual({
      '::-webkit-scrollbar-thumb': 'transparent',
      '[data-scrolling]::-webkit-scrollbar-thumb': 'var(--border-color)',
      '::-webkit-scrollbar-thumb:hover': 'var(--text-tertiary)',
    })
  })

  it('页面级滚动(target 是 document)落到根元素上', () => {
    uninstall = installScrollbarAutoHide(document, 800)
    document.dispatchEvent(new Event('scroll'))
    expect(document.documentElement.hasAttribute('data-scrolling')).toBe(true)
  })

  it('卸载后不再打标记 —— 否则换页/热更会越堆越多', () => {
    const stop = installScrollbarAutoHide(document, 800)
    const el = scrollableDiv()
    stop()

    el.dispatchEvent(new Event('scroll'))
    expect(el.hasAttribute('data-scrolling')).toBe(false)
  })
})
