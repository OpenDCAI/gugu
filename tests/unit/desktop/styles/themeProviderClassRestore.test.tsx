// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { ThemeProvider } from '@gugu/session-ui/react/primitives'
// @@@4259-theme-class-restore — #4259 的触发器。
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const THEME_CLASSES = ['emlight', 'emdark', 'emsolarized-light', 'emsolarized-dark']
const themeClasses = () => THEME_CLASSES.filter((cls) => document.documentElement.classList.contains(cls))
let root: Root | null = null
let host: HTMLElement | null = null
function render(node: React.ReactNode) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => { root!.render(node) })
}
afterEach(() => {
  if (root) act(() => { root!.unmount() })
  host?.remove()
  root = null
  host = null
  document.documentElement.classList.remove(...THEME_CLASSES)
})
describe('#4259 ThemeProvider(documentElement)的 <html> 主题类', () => {
  it('嵌套 provider 卸载后,外层那个类必须还在', () => {
    render(
      <ThemeProvider theme="light" target="documentElement">
        <span>outer</span>
      </ThemeProvider>,
    )
    expect(themeClasses(), '外层挂载后 <html> 应带 emlight').toEqual(['emlight'])
    const inner = document.createElement('div')
    document.body.appendChild(inner)
    const innerRoot = createRoot(inner)
    act(() => {
      innerRoot.render(
        <ThemeProvider theme="dark" target="documentElement">
          <span>inner</span>
        </ThemeProvider>,
      )
    })
    expect(themeClasses(), '内层挂载后由它接管 <html>').toEqual(['emdark'])
    act(() => { innerRoot.unmount() })
    inner.remove()
    expect(
      themeClasses(),
      '内层卸载后 <html> 必须还原成外层那个类 —— 清空会让只在该类下定义的令牌全文档变成未定义(#4259)',
    ).toEqual(['emlight'])
  })
})
