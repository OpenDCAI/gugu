/**
 * #3334 shadcn 语义色桥的回归判据。
 *
 * 为什么必须真 Chromium:这条要判的是「工具类最终解析成什么颜色」,而 Tailwind v4 对
 * @theme 里没有的 color key **静默丢掉整条 utility** —— 没有报错、没有警告,类名照样写在
 * DOM 上。所以 class 存在、快照通过、typecheck 通过都证明不了它上色了,只有真实排版后的
 * getComputedStyle 能。
 *
 * 两个作用域都要判,因为 #2804 拆掉 shadow root 之后**两张样式表在同一个 <head> 里**:
 * 咕咕那张先进,EmdashSessionFrame 把会话页那张后注入 ⇒ 同名 utility 会话页赢,而且是全文档赢。
 * 于是桥接写错会往两个方向坏:
 *   · 会话页作用域取不到会话页 token(桥没生效);
 *   · 咕咕作用域取不到咕咕 token(桥把咕咕带塌了)。
 *
 * 判据刻意不写死色值:每个工具类都和一个直接引用目标变量的参照元素比,so 改主题色不会让
 * 这条测试变红,只有**桥接指错了变量**才会。
 */
import { describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import '@/styles/tokens.css'
import '@renderer/index.css'

/** [工具类, 读哪个 CSS 属性, 会话页作用域应等于的变量, 咕咕作用域应等于的变量] */
const BRIDGE: Array<[string, keyof CSSStyleDeclaration, string, string]> = [
  ['bg-background', 'backgroundColor', '--background', '--bg'],
  ['bg-card', 'backgroundColor', '--background-1', '--card'],
  ['bg-popover', 'backgroundColor', '--background-quaternary', '--popover'],
  ['bg-primary', 'backgroundColor', '--primary-button-background', '--primary'],
  ['bg-secondary', 'backgroundColor', '--background-2', '--muted'],
  ['bg-muted', 'backgroundColor', '--background-2', '--muted'],
  ['bg-accent', 'backgroundColor', '--background-quaternary-1', '--hover'],
  ['bg-destructive', 'backgroundColor', '--red-9', '--danger'],
  ['text-foreground', 'color', '--foreground', '--fg'],
  ['text-card-foreground', 'color', '--foreground', '--text-primary'],
  ['text-popover-foreground', 'color', '--foreground', '--text-primary'],
  ['text-primary-foreground', 'color', '--primary-button-foreground', '--primary-fg'],
  ['text-secondary-foreground', 'color', '--foreground-muted', '--text-primary'],
  ['text-muted-foreground', 'color', '--foreground-muted', '--muted-fg'],
  ['text-accent-foreground', 'color', '--foreground', '--text-primary'],
  ['border-border', 'borderTopColor', '--border', '--border'],
  ['border-input', 'borderTopColor', '--border', '--border-color'],
]

/** destructive-foreground 两个作用域同源(恒为白),单独列 */
const ALWAYS_WHITE: Array<[string, keyof CSSStyleDeclaration]> = [
  ['text-destructive-foreground', 'color'],
]

/** 只在会话页作用域判「有没有真的上色」的实底 —— 空态/透明会在这里红 */
const OPAQUE_SURFACES = [
  'bg-background',
  'bg-card',
  'bg-popover',
  'bg-primary',
  'bg-secondary',
  'bg-muted',
  'bg-accent',
  'bg-destructive',
]

/** 实底块在截图里配的前景类,只影响可读性,不参与断言 */
const PAIRED_FG: Record<string, string> = {
  'bg-background': 'text-foreground',
  'bg-card': 'text-card-foreground',
  'bg-popover': 'text-popover-foreground',
  'bg-primary': 'text-primary-foreground',
  'bg-secondary': 'text-secondary-foreground',
  'bg-muted': 'text-muted-foreground',
  'bg-accent': 'text-accent-foreground',
  'bg-destructive': 'text-destructive-foreground',
}

/** 前景类在截图里垫的实底,同理只影响可读性 —— 否则 text-primary-foreground 是白底白字 */
const PAIRED_BG: Record<string, string> = {
  'text-foreground': 'bg-background',
  'text-card-foreground': 'bg-card',
  'text-popover-foreground': 'bg-popover',
  'text-primary-foreground': 'bg-primary',
  'text-secondary-foreground': 'bg-secondary',
  'text-muted-foreground': 'bg-muted',
  'text-accent-foreground': 'bg-accent',
  'text-destructive-foreground': 'bg-destructive',
}

type Scope = { name: string; className: string; theme: 'light' | 'dark'; varKey: 2 | 3 }

const SCOPES: Scope[] = [
  { name: 'emlight', className: 'emlight gugu-skin', theme: 'light', varKey: 2 },
  { name: 'emdark', className: 'emdark gugu-skin', theme: 'dark', varKey: 2 },
  { name: 'gugu-light', className: '', theme: 'light', varKey: 3 },
  { name: 'gugu-dark', className: '', theme: 'dark', varKey: 3 },
]

/** 解析 rgb()/rgba()/color(display-p3 …) → 0..1 的 [r,g,b,a];认不出就抛,不静默返回 0 */
function parseColor(v: string): [number, number, number, number] {
  const p3 = v.match(/^color\(display-p3\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)(?:\s*\/\s*([\d.]+))?\)$/)
  if (p3) return [+p3[1], +p3[2], +p3[3], p3[4] === undefined ? 1 : +p3[4]]
  const rgb = v.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/)
  if (rgb) return [+rgb[1] / 255, +rgb[2] / 255, +rgb[3] / 255, rgb[4] === undefined ? 1 : +rgb[4]]
  throw new Error(`unparseable color: ${JSON.stringify(v)}`)
}

let host: HTMLDivElement | null = null

/**
 * 画一屏色板:每个工具类一块,块内同时挂参照元素(直接 var(目标变量))。
 * 返回 [工具类解析值, 参照解析值] 的对照表。
 */
function render(scope: Scope): {
  actual: Record<string, string>
  expected: Record<string, string>
} {
  document.documentElement.dataset.theme = scope.theme
  host?.remove()
  host = document.createElement('div')
  host.className = scope.className
  host.style.cssText =
    'padding:16px;display:flex;flex-wrap:wrap;gap:10px;width:1248px;font:13px/1.5 sans-serif'
  document.body.style.margin = '0'
  document.body.appendChild(host)

  const actual: Record<string, string> = {}
  const expected: Record<string, string> = {}

  for (const entry of BRIDGE) {
    const [cls, prop] = entry
    const targetVar = entry[scope.varKey] as string
    const cell = document.createElement('div')
    cell.style.cssText = 'width:230px;border-radius:6px;overflow:hidden'

    const swatch = document.createElement('div')
    // 配上成对的另一半,否则深底深字 / 白底白字,截图里看不出这块到底上没上色
    swatch.className = `${cls} ${PAIRED_FG[cls] ?? PAIRED_BG[cls] ?? ''} border`.trim()
    swatch.style.cssText = 'height:52px;display:flex;align-items:center;justify-content:center'
    swatch.textContent = cls
    cell.appendChild(swatch)

    const reference = document.createElement('div')
    const cssProp =
      prop === 'color' ? 'color' : prop === 'borderTopColor' ? 'border-top-color' : 'background-color'
    reference.style.cssText = `${cssProp}:var(${targetVar});border-top-style:solid;border-top-width:1px;height:1px`
    cell.appendChild(reference)

    host.appendChild(cell)
    actual[cls] = getComputedStyle(swatch)[prop] as string
    expected[cls] = getComputedStyle(reference)[prop] as string
  }

  for (const [cls, prop] of ALWAYS_WHITE) {
    const swatch = document.createElement('div')
    swatch.className = `${cls} bg-destructive`
    swatch.style.cssText = 'width:200px;height:52px;display:flex;align-items:center;justify-content:center'
    swatch.textContent = cls
    host.appendChild(swatch)
    actual[cls] = getComputedStyle(swatch)[prop] as string
    expected[cls] = 'rgb(255, 255, 255)'
  }

  return { actual, expected }
}

describe('#3334 shadcn 语义色 → 会话页 token 桥', () => {
  it('#3370 任务页样式注入后咕咕 scope 的 6 个 bg-background 仍有实底', async () => {
    await page.viewport(1280, 720)
    document.documentElement.dataset.theme = 'dark'
    host?.remove()
    host = document.createElement('div')
    host.style.cssText =
      'padding:24px;display:grid;grid-template-columns:repeat(3,1fr);gap:12px;width:1120px;font:13px/1.5 sans-serif'
    document.body.style.margin = '0'
    document.body.appendChild(host)

    const expectedReference = document.createElement('div')
    expectedReference.style.backgroundColor = 'var(--bg)'
    const controlReference = document.createElement('div')
    controlReference.style.backgroundColor = 'var(--card)'
    host.append(expectedReference, controlReference)

    const targets = Array.from({ length: 6 }, (_, index) => {
      const target = document.createElement('div')
      target.className = 'bg-background text-foreground'
      target.style.cssText =
        'min-height:96px;border:1px solid var(--border-color);border-radius:6px;padding:16px'
      target.textContent = `bg-background #${index + 1}`
      host!.appendChild(target)
      return target
    })

    const positiveControl = document.createElement('div')
    positiveControl.className = 'bg-card text-card-foreground'
    positiveControl.style.cssText =
      'min-height:96px;border:1px solid var(--border-color);border-radius:6px;padding:16px'
    positiveControl.textContent = 'positive control: bg-card'
    host.appendChild(positiveControl)

    const expected = getComputedStyle(expectedReference).backgroundColor
    const readings = targets.map((target) => getComputedStyle(target).backgroundColor)
    const controlExpected = getComputedStyle(controlReference).backgroundColor
    const controlActual = getComputedStyle(positiveControl).backgroundColor
    targets.forEach((target, index) => {
      target.textContent = `bg-background #${index + 1}\ncomputed: ${readings[index]}`
    })
    positiveControl.textContent = `positive control: bg-card\ncomputed: ${controlActual}`

    expect(targets).toHaveLength(6)
    expect(controlActual, '阳性对照必须命中咕咕 --card').toBe(controlExpected)
    expect(controlActual, '阳性对照不能透明').not.toBe('rgba(0, 0, 0, 0)')
    await page.screenshot({ path: 'shots/issue-3370-gugu-bg-background.png' })
    for (const [index, actual] of readings.entries()) {
      expect(actual, `咕咕 bg-background #${index + 1}`).toBe(expected)
      expect(actual, `咕咕 bg-background #${index + 1} 不能透明`).not.toBe('rgba(0, 0, 0, 0)')
    }
  })

  it('每个语义名在会话页作用域解析到它对应的会话页 token', async () => {
    // 视口必须显式设:默认视口只有 335px 宽,色板会被裁掉一大半,而**截图看起来仍然正常**
    // (剩下的块排得整整齐齐)—— 那种截图会被当成「全部通过」的证据。
    await page.viewport(1280, 1000)
    for (const scope of SCOPES.filter((s) => s.varKey === 2)) {
      const { actual, expected } = render(scope)
      for (const [cls] of [...BRIDGE, ...ALWAYS_WHITE]) {
        expect(actual[cls], `${scope.name} / ${cls}`).toBe(expected[cls])
      }
      // 截图前先钉住块数:截图是给人看的,而人看不出「少了 8 块」
      expect(host!.children.length, `${scope.name} 色板块数`).toBe(BRIDGE.length + ALWAYS_WHITE.length)
      await page.screenshot({ path: `shots/tokens-${scope.name}.png` })
    }
  })

  it('同一批语义名在咕咕作用域仍解析到咕咕 token(兜底段没写错,不把咕咕带塌)', () => {
    for (const scope of SCOPES.filter((s) => s.varKey === 3)) {
      const { actual, expected } = render(scope)
      for (const [cls] of BRIDGE) {
        expect(actual[cls], `${scope.name} / ${cls}`).toBe(expected[cls])
      }
    }
  })

  it('会话页两个主题下每块实底都真的上了色(不是透明、不是纯黑)', () => {
    for (const scope of SCOPES.filter((s) => s.varKey === 2)) {
      const { actual } = render(scope)
      for (const cls of OPAQUE_SURFACES) {
        const [r, g, b, a] = parseColor(actual[cls])
        expect(a, `${scope.name} / ${cls} 透明`).toBeGreaterThan(0.9)
        expect(r + g + b, `${scope.name} / ${cls} 纯黑`).toBeGreaterThan(0.02)
      }
    }
  })

  it('编译后的 ring utility 的 computed color 落到 --border-primary', () => {
    for (const scope of SCOPES.filter((s) => s.varKey === 2)) {
      render(scope)

      const ring = document.createElement('div')
      ring.className = 'ring-1 ring-border-primary'
      // Tailwind registers --tw-ring-color with inherits:false, so read it on the ring element itself.
      ring.style.cssText = 'width:24px;height:24px;color:var(--tw-ring-color)'

      const reference = document.createElement('span')
      reference.style.color = 'var(--border-primary)'
      host!.append(ring, reference)

      expect(getComputedStyle(ring).boxShadow, `${scope.name} / ring-1`).not.toBe('none')
      expect(getComputedStyle(ring).color, `${scope.name} / ring-border-primary`).toBe(
        getComputedStyle(reference).color
      )
    }
  })
})
