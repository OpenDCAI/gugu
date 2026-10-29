/**
 * @@@dark-material-veil — 深色 + mac 原生材质时,导航列在材质上默认铺一层 70% 的 --bg 薄纱。
 * 材质本身随窗口背后内容变:mac1 屏幕合成实测深色 sidebar 材质在 rgb(43,47,49)(背后深)… rgb(76,79,82)(背后白)之间。
 * 这里把真 tokens 算出来的薄纱叠到这两头上(canvas 合成,与屏幕同一个 alpha 叠法),读分区标题色 --muted-fg 的对比度。
 */
import { afterEach, expect, it } from 'vitest'
import '@/styles/tokens.css'

const MATERIAL_EXTREMES = [[43, 47, 49], [76, 79, 82]] as const

afterEach(() => {
  delete document.documentElement.dataset.theme
  delete document.documentElement.dataset.windowMaterial
  document.documentElement.removeAttribute('data-sidebar-tint')
  document.body.replaceChildren()
})

function mountNavPane(): { pane: HTMLElement; ink: (cssVar: string) => string } {
  const shell = document.body.appendChild(document.createElement('div'))
  shell.setAttribute('data-gugu-shell-phase', 'active')
  const pane = shell.appendChild(document.createElement('div'))
  pane.className = 'gg-pane'
  pane.dataset.role = 'nav'
  const probe = pane.appendChild(document.createElement('span'))
  return { pane, ink: (cssVar) => { probe.style.color = `var(${cssVar})`; return getComputedStyle(probe).color } }
}

/** 用 canvas 把 CSS 颜色(含 alpha、oklab)叠到一块不透明底上,读回合成后的 sRGB。 */
function over(css: string, base: readonly number[]): number[] {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
  ctx.fillStyle = `rgb(${base.join(',')})`
  ctx.fillRect(0, 0, 1, 1)
  ctx.fillStyle = css
  ctx.fillRect(0, 0, 1, 1)
  return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)]
}

const luminance = (c: readonly number[]) => {
  const [r, g, b] = c.map((v) => v / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
const contrast = (a: readonly number[], b: readonly number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

it.each(MATERIAL_EXTREMES)('dark native: the section title reads at 4.5:1 or better on the veiled material rgb(%i,%i,%i), below the row text', (...material) => {
  document.documentElement.dataset.windowMaterial = 'native'
  const { pane, ink } = mountNavPane()
  const surface = over(getComputedStyle(pane).backgroundColor, material)
  const title = over(ink('--muted-fg'), surface)
  const row = over(ink('--fg'), surface)
  expect(contrast(title, surface)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(row, surface)).toBeGreaterThan(contrast(title, surface))
})

it('dark native: the veil is there with the tint option off and on alike', () => {
  document.documentElement.dataset.windowMaterial = 'native'
  const { pane } = mountNavPane()
  const off = getComputedStyle(pane).backgroundColor
  document.documentElement.setAttribute('data-sidebar-tint', 'on')
  expect(getComputedStyle(pane).backgroundColor).toBe(off)
  expect(off).not.toBe('rgba(0, 0, 0, 0)')
})

it('light native keeps the nav column clear: its veil is still the tint option alone', () => {
  document.documentElement.dataset.windowMaterial = 'native'
  document.documentElement.dataset.theme = 'light'
  const { pane } = mountNavPane()
  expect(getComputedStyle(pane).backgroundColor).toBe('rgba(0, 0, 0, 0)')
})
