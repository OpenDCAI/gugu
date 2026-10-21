// @vitest-environment jsdom
// 手机页的搜索收在页头(owner 10-07:常驻搜索框太占地方):平时一颗放大镜,点开才有框;取消 / 安卓返回键收起并清空。
import { act, createElement, useState, type ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { clickElement, createReactHarness, typeInto } from '../../../support/testHarness'
import { HeaderSearch } from '../../../../apps/desktop/src/components/ui/HeaderSearch'
import { isSheetOpen } from '../../../../apps/desktop/src/components/ui/sheetStack'

type BackState = Window & { __guguNativeBackHandled?: boolean }

function Page({ mobile, active, initial = '' }: { mobile: boolean; active?: boolean; initial?: string }) {
  const [query, setQuery] = useState(initial)
  return createElement('div', null,
    createElement(HeaderSearch, {
      mobile, active, value: query, onChange: setQuery, placeholder: 'Search', testId: 'page-search',
      children: (button: ReactNode) => createElement('div', { 'data-testid': 'page-header' }, 'Title', button),
    }),
    createElement('output', { 'data-testid': 'query' }, query),
  )
}

describe('HeaderSearch', () => {
  let harness: ReturnType<typeof createReactHarness> | null = null
  afterEach(() => { harness?.cleanup(); harness = null })
  const $ = (selector: string) => harness!.container.querySelector(selector) as HTMLElement | null
  const input = () => $('[data-testid="page-search"]') as HTMLInputElement | null
  const query = () => $('[data-testid="query"]')!.textContent

  it('桌面只交出 null,页面照旧画自己的页头', async () => {
    harness = createReactHarness()
    await harness.render(createElement(Page, { mobile: false, initial: 'kept' }))
    expect($('[data-testid="page-header"]')).toBeTruthy()
    expect($('[data-header-search-open]')).toBeNull()
    expect(input()).toBeNull()
  })

  it('点放大镜:聚焦的框盖在页头上(页头留着,不重挂);输入改的是页面那份搜索词;取消收起并清空', async () => {
    harness = createReactHarness()
    await harness.render(createElement(Page, { mobile: true }))
    expect(input()).toBeNull()
    const header = $('[data-testid="page-header"]')
    await clickElement($('[data-header-search-open]')!)
    expect($('[data-header-search]')?.contains(input())).toBe(true)
    expect($('[data-testid="page-header"]')).toBe(header)
    expect(document.activeElement).toBe(input())

    await typeInto(input()!, 'alpha')
    expect(query()).toBe('alpha')
    await typeInto(input()!, '')
    expect(input()).toBeTruthy() // 点开的框清空了也不收,收起只认取消

    await typeInto(input()!, 'beta')
    await clickElement($('[data-header-search-cancel]')!)
    expect(query()).toBe('')
    expect(input()).toBeNull()
    expect($('[data-header-search]')).toBeNull()
    expect($('[data-testid="page-header"]')).toBe(header)
  })

  it('有搜索词就展开:页面重挂(从结果点进详情再返回)时框跟着词回来,但不抢焦点', async () => {
    harness = createReactHarness()
    await harness.render(createElement(Page, { mobile: true, initial: 'zs' }))
    expect(input()?.value).toBe('zs')
    expect(document.activeElement).not.toBe(input())
  })

  it('安卓返回键 = 取消;页不在屏上时不进返回栈', async () => {
    harness = createReactHarness()
    await harness.render(createElement(Page, { mobile: true, active: false, initial: 'x' }))
    expect(isSheetOpen()).toBe(false)

    await harness.render(createElement(Page, { mobile: true, active: true, initial: 'x' }))
    expect(isSheetOpen()).toBe(true)
    const state = window as BackState
    state.__guguNativeBackHandled = false
    await act(async () => { window.dispatchEvent(new CustomEvent('gugu:native-back')) })
    expect(state.__guguNativeBackHandled).toBe(true)
    expect(query()).toBe('')
    expect(input()).toBeNull()
    expect(isSheetOpen()).toBe(false)
  })
})
