// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsGroup, SettingsRow } from '@/components/settings/SettingsPrimitives'

// @@@6436 设置各内页共用的行:桌面弹窗与手机「我的」是同一份标记,窄屏换行只由 data-stack 交给 CSS。
// 这里钉的是那份标记的合同 —— 可点的行键盘也按得动、行尾自己的按钮不会连带触发整行、
// 需要窄屏换行的行带着 data-stack(settings.css 的容器查询只认它)。

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

// data-* 在 JSX 里是放行的,在 createElement 的对象字面量里会撞 TS 的多余属性检查 —— 用展开传。
const tid = (id: string): Record<string, string> => ({ 'data-testid': id })

function render(node: ReturnType<typeof createElement>) {
  act(() => root.render(node))
}

function press(target: Element, key: string) {
  act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
}

describe('SettingsRow', () => {
  it('is a keyboard-operable button row when it has onClick', () => {
    const onClick = vi.fn()
    render(createElement(SettingsRow, { title: 'Release notes', onClick, ...tid('row') }))
    const row = container.querySelector('[data-testid="row"]') as HTMLElement
    expect(row.getAttribute('role')).toBe('button')
    expect(row.tabIndex).toBe(0)
    press(row, 'Enter')
    press(row, ' ')
    expect(onClick).toHaveBeenCalledTimes(2)
    press(row, 'a')
    expect(onClick).toHaveBeenCalledTimes(2)
  })

  it('does not fire the row when a key is pressed inside it (e.g. typing in a nested field)', () => {
    const onClick = vi.fn()
    render(createElement(SettingsRow, {
      title: 'Permission',
      onClick,
      ...tid('row'),
      control: createElement('input', tid('inner')),
    }))
    press(container.querySelector('[data-testid="inner"]') as Element, 'Enter')
    expect(onClick).not.toHaveBeenCalled()
  })

  it('is plain content without onClick, and carries the layout hints the stylesheet reads', () => {
    render(createElement(SettingsRow, {
      ...tid('row'),
      leading: createElement('span', null, 'icon'),
      title: 'Device',
      description: 'host · v1',
      control: createElement('span', null, 'actions'),
      stack: true,
    }))
    const row = container.querySelector('[data-testid="row"]') as HTMLElement
    expect(row.getAttribute('role')).toBeNull()
    expect(row.hasAttribute('tabindex')).toBe(false)
    expect(row.getAttribute('data-stack')).toBe('true')
    expect(row.getAttribute('data-leading')).toBe('true')
    expect(row.querySelector('.gg-settings-row-description')?.textContent).toBe('host · v1')
    expect(row.querySelector('.gg-settings-row-control')?.textContent).toBe('actions')
  })

  it('omits the leading and stack hints when the row has neither', () => {
    render(createElement(SettingsRow, { ...tid('row'), title: 'Language' }))
    const row = container.querySelector('[data-testid="row"]') as HTMLElement
    expect(row.hasAttribute('data-leading')).toBe(false)
    expect(row.hasAttribute('data-stack')).toBe(false)
    expect(row.querySelector('.gg-settings-row-control')).toBeNull()
  })
})

describe('SettingsGroup', () => {
  it('puts the title and note above one card, and the footer after it', () => {
    render(createElement(SettingsGroup, {
      ...tid('group'),
      title: 'Notifications',
      note: 'Only this app',
      footer: createElement('p', tid('footer'), 'Sent'),
    }, createElement(SettingsRow, { title: 'Chat' }), createElement(SettingsRow, { title: 'Sound' })))
    const group = container.querySelector('[data-testid="group"]') as HTMLElement
    const children = Array.from(group.children)
    expect(children.map((child) => child.className.split(' ')[0])).toEqual([
      'gg-section-label', 'gg-settings-note', 'gg-settings-card', '',
    ])
    expect(group.querySelector('.gg-settings-card')?.querySelectorAll('.gg-settings-row')).toHaveLength(2)
    expect(children[3]?.getAttribute('data-testid')).toBe('footer')
  })
})
