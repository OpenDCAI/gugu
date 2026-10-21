// @vitest-environment jsdom
// 安卓返回键 = Escape:最上层的 Sheet 自己接住,页面那一层(MainLayout)有 Sheet 开着时不动下面的页面。
// 2026-09-27 模拟器实测(#6606):「转发」弹层开着按返回键,弹层留在原处、底下的会话页先退回了列表。
import { act, createElement } from 'react'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { Sheet } from '../../../../apps/desktop/src/components/ui/Sheet'
import { DropdownMenu, Menu, MenuItem } from '../../../../apps/desktop/src/components/ui/Menu'
import { isSheetOpen, useBackLayer } from '../../../../apps/desktop/src/components/ui/sheetStack'
import { SettingsPageHead } from '../../../../apps/desktop/src/components/chat/groupSettingsUi'

type BackState = Window & { __guguNativeBackHandled?: boolean }

describe('安卓返回键关的是最上层的 Sheet', () => {
  let harness: ReturnType<typeof createReactHarness> | null = null
  afterEach(() => { harness?.cleanup(); harness = null })

  it('只关最上层那一个,并告诉原生「已处理」;全关掉之后 isSheetOpen 回到 false', async () => {
    harness = createReactHarness()
    const outer = vi.fn()
    const inner = vi.fn()
    expect(isSheetOpen()).toBe(false)
    // 先开外层、再开内层:与真实使用同序(子弹层总是在父弹层已经显示之后才打开)。
    await harness.render(createElement(Sheet, { onClose: outer, ariaLabel: 'outer', children: 'outer body' }))
    await harness.render(createElement(Sheet, { onClose: outer, ariaLabel: 'outer', children: createElement(Sheet, { onClose: inner, ariaLabel: 'inner', children: 'inner body' }) }))
    expect(isSheetOpen()).toBe(true)

    const state = window as BackState
    state.__guguNativeBackHandled = false
    await act(async () => { window.dispatchEvent(new CustomEvent('gugu:native-back')) })
    expect(inner).toHaveBeenCalledTimes(1)
    expect(outer).not.toHaveBeenCalled()
    expect(state.__guguNativeBackHandled).toBe(true)
    const popup = [...document.querySelectorAll<HTMLElement>('[data-slot="dialog-popup"]')].at(-1)!
    await act(async () => { popup.focus(); popup.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(inner).toHaveBeenCalledTimes(2)
    expect(outer).not.toHaveBeenCalled()

    harness.cleanup()
    harness = null
    expect(isSheetOpen()).toBe(false)
  })

  it('onEscape 接住了(内部先退一层)就不关整个 Sheet', async () => {
    harness = createReactHarness()
    const onClose = vi.fn()
    const onEscape = vi.fn(() => true)
    await harness.render(createElement(Sheet, { onClose, onEscape, ariaLabel: 'nested pane', children: 'body' }))
    await act(async () => { window.dispatchEvent(new CustomEvent('gugu:native-back')) })
    expect(onEscape).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('页面那一层的返回键处理先问有没有 Sheet 开着(不靠监听器注册先后)', () => {
    const source = readFileSync('apps/desktop/src/layouts/MainLayout.tsx', 'utf8')
    const handler = source.slice(source.indexOf('const handleNativeBack = () => {'))
    expect(handler.slice(0, 400)).toMatch(/const handleNativeBack = \(\) => \{\s*\/\/[^\n]*\n\s*if \(isSheetOpen\(\)\) return/)
  })
})

// 2026-09-29 安卓真壳实测:联系人子页按返回键整个 App 退到桌面;话题页 / 群设置页越级退到会话列表;
// 页头「⋯」菜单开着按返回,会话页退走、菜单浮在列表上。它们都是盖在页面上的一层,却没进这个栈。
describe('盖在页面上的每一层都进同一个栈', () => {
  let harness: ReturnType<typeof createReactHarness> | null = null
  afterEach(() => { harness?.cleanup(); harness = null })
  const back = async () => {
    const state = window as BackState
    state.__guguNativeBackHandled = false
    await act(async () => { window.dispatchEvent(new CustomEvent('gugu:native-back')) })
    return state.__guguNativeBackHandled
  }
  function Layer({ onBack, active, children }: { onBack: () => void; active?: boolean; children?: unknown }) {
    useBackLayer(onBack, active)
    return createElement('div', null, children as never)
  }

  it('后开的一层先接返回键;关掉它,下一下归下面那层;没开的层不进栈', async () => {
    harness = createReactHarness()
    const page = vi.fn()
    const menu = vi.fn()
    const hidden = vi.fn()
    await harness.render(createElement(Layer, { onBack: page }, createElement(Layer, { onBack: hidden, active: false })))
    await harness.render(createElement(Layer, { onBack: page }, createElement(Layer, { onBack: hidden, active: false }), createElement(Layer, { onBack: menu })))
    expect(await back()).toBe(true)
    expect(menu).toHaveBeenCalledTimes(1)
    expect(page).not.toHaveBeenCalled()
    await harness.render(createElement(Layer, { onBack: page }, createElement(Layer, { onBack: hidden, active: false })))
    expect(await back()).toBe(true)
    expect(page).toHaveBeenCalledTimes(1)
    expect(hidden).not.toHaveBeenCalled()
    harness.cleanup()
    harness = null
    expect(isSheetOpen()).toBe(false)
    expect(await back()).toBe(false)
  })

  it('开着的菜单先被返回键关掉(Menu 与受控 DropdownMenu)', async () => {
    harness = createReactHarness()
    const onClose = vi.fn()
    await harness.render(createElement(Menu, { x: 10, y: 10, onClose, children: createElement(MenuItem, null, 'copy') }))
    expect(await back()).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
    harness.cleanup()

    harness = createReactHarness()
    const onOpenChange = vi.fn()
    await harness.render(createElement(DropdownMenu.Root, { open: true, modal: false, onOpenChange },
      createElement(DropdownMenu.Trigger, null, 'more'),
      createElement(DropdownMenu.Content, null, createElement(MenuItem, null, 'settings'))))
    expect(await back()).toBe(true)
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything())
    await harness.render(createElement(DropdownMenu.Root, { open: false, modal: false, onOpenChange }, createElement(DropdownMenu.Trigger, null, 'more')))
    expect(isSheetOpen()).toBe(false)
  })

  it('手机上的设置页头 = 一整页,返回键走它的左上返回;桌面不进栈', async () => {
    harness = createReactHarness()
    const onBack = vi.fn()
    await harness.render(createElement(SettingsPageHead, { title: 'settings', onBack, mobile: true }))
    expect(await back()).toBe(true)
    expect(onBack).toHaveBeenCalledTimes(1)
    await harness.render(createElement(SettingsPageHead, { title: 'settings', onBack, mobile: false }))
    expect(isSheetOpen()).toBe(false)
  })
})
