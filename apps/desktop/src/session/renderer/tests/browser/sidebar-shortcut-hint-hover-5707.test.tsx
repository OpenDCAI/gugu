/**
 * #5707 侧栏行尾键帽:静止不画、悬浮才淡入 —— 真 Chromium、真 CSS、真组件。
 *
 * **为什么必须真浏览器**:要判的是「`opacity-0` 与 `group-hover/row:opacity-100` 最终算出什么」,
 * 而这件事在这个仓里被证明过不能从类名推断 —— #3480 的 `px-3` 写在 `<button>` 上,类名在 DOM 上、
 * 值恒为 0(session-chat-ui 一条**未分层**的 `button { padding: 0 }` 恒胜 @layer 里的工具类)。
 * Tailwind v4 还会对扫不到的类**静默丢掉整条 utility**。所以 class 存在、typecheck 通过、
 * 快照通过,三样都证明不了它真的隐去或真的淡入,只有真实排版后的 getComputedStyle 能。
 *
 * **悬浮也必须是真的**:`:hover` 不是可以 dispatch 出来的事件状态,它由引擎按指针位置判定。
 * `userEvent.hover` 走 playwright 的真指针,所以这里量到的 1 是引擎自己算的,不是测试摆的。
 *
 * 三条判据对着 issue 的三句话:
 *   ① 静止 = 0 —— 「不应该常驻」。
 *   ② 悬浮那一行 = 1 **且另一行仍是 0** —— 「不应该重复出现」。少了后半句,一条把所有键帽
 *      一起点亮的实现也能过。
 *   ③ 键帽的 rect 在两态之间一格不动 —— 隐去用的是 opacity 而不是卸载节点,所以标题的截断宽度
 *      与右缘那条竖线不会在指针进出时抖一下。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'

// 搜索行点下去打开 ⌘K 那个面板(弹窗注册表会把整棵 app-state 建起来,那些要 IPC)—— 这条测试只量键帽,给一个不开窗的替身。
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => () => {}, showModal: () => {} }))

import {
  SidebarMenu,
  SidebarMenuButton,
  sidebarRowContentInsetX,
  sidebarRowShortcutClass,
} from '@renderer/features/sidebar/sidebar-primitives'
import { SidebarSearchTrigger } from '@renderer/features/sidebar/sidebar-search-trigger'
import { BoundShortcut } from '@renderer/lib/ui/shortcut'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { cn } from '@renderer/utils/utils'
import '@renderer/index.css'

let root: Root
let host: HTMLDivElement
let pointerPark: HTMLElement

beforeEach(async () => {
  host = document.createElement('div')
  // 主题变量挂在 emlight/emdark 上(lib/theme/host-theme.ts);少了它键帽的边框与底色算不出来。
  // 宽度取侧栏常规宽,行才按产品里的样子排。
  host.className = 'gugu-skin emlight'
  host.style.width = '260px'
  document.body.append(host)
  root = createRoot(host)
  // 真指针跨用例保留坐标；必须在挂载之前挪开，否则「静止态」可能已经开始淡入。
  pointerPark = park()
  await userEvent.hover(pointerPark)
})

afterEach(() => {
  root.unmount()
  host.remove()
  pointerPark.remove()
})

/**
 * 搜索行是**产品自己的组件**(真调用点);下面那一行走的是页脚两行同一套原语组合
 * (`SidebarMenuButton` + `group/row` + `sidebarRowShortcutClass`)。
 *
 * ⚠️ 诚实标注:页脚那两行(资源库 / 设置)写在 `left-sidebar.tsx` 里、没有单独导出,
 * 所以这里站着的是**同构的一行**,不是那两行本身。这条守的是「这套组合算出什么」;
 * 「那两行有没有用这套组合」由页脚行与本行共用同一个导出常量来保证,并由 PR 里的实机截图取证。
 */
function mount(): void {
  root.render(
    <QueryClientProvider client={new QueryClient()}>
      <SessionLocalizationProvider>
        <SidebarMenu>
          <SidebarSearchTrigger />
          <SidebarMenuButton aria-label="settings-like" className="group/row w-full justify-between">
            <span className={cn('flex min-w-0 items-center gap-2', sidebarRowContentInsetX)}>
              <span className="truncate">设置</span>
            </span>
            <BoundShortcut
              commandId="app.settings"
              variant="keycaps"
              className={sidebarRowShortcutClass}
            />
          </SidebarMenuButton>
        </SidebarMenu>
      </SessionLocalizationProvider>
    </QueryClientProvider>
  )
}

/** 两个键帽,按它们在 DOM 里的先后:搜索行的 ⌘K、设置行的 ⌘,。 */
function keycaps(): [HTMLElement, HTMLElement] {
  const found = Array.from(host.querySelectorAll<HTMLElement>('[data-slot="shortcut"]'))
  expect(found, '两行都该渲出键帽 —— 少一个,下面的读数就变成在量空气').toHaveLength(2)
  return [found[0], found[1]]
}

const opacityOf = (el: HTMLElement): number => Number.parseFloat(getComputedStyle(el).opacity)

/** 一块谁也不挡的角落,用来把真指针挪出侧栏(它跨用例留在原地)。 */
function park(): HTMLElement {
  const el = document.createElement('div')
  el.style.cssText = 'position:fixed;right:0;bottom:0;width:120px;height:120px'
  document.body.append(el)
  return el
}

/** 等过渡落定再量 —— 键帽走的是 --dur-fast 那一档,量在半路会读到中间值。 */
async function settledOpacity(el: HTMLElement, expected: number): Promise<void> {
  await until(`opacity settles at ${expected}`, () => Math.abs(opacityOf(el) - expected) < 0.005)
}

it('#5707 键帽静止不画、只在指针所在的那一行淡入,且两态之间不挪位', async () => {
  mount()
  await until('both keycaps mounted', () => host.querySelectorAll('[data-slot="shortcut"]').length === 2)

  const [searchCap, settingsCap] = keycaps()

  // 阳性对照:键帽得真的在排版里占着一格,否则「opacity 为 0」与「根本没渲出来」同形。
  for (const cap of [searchCap, settingsCap]) {
    expect(cap.getBoundingClientRect().width).toBeGreaterThan(0)
  }
  const restRects = [searchCap, settingsCap].map((c) => c.getBoundingClientRect())

  // ① 静止:两处都不画。
  expect(opacityOf(searchCap)).toBe(0)
  expect(opacityOf(settingsCap)).toBe(0)

  // ② 悬浮搜索行:只有它亮。
  await userEvent.hover(searchCap.parentElement as HTMLElement)
  await settledOpacity(searchCap, 1)
  expect(opacityOf(settingsCap), '另一行不该跟着一起亮 —— 那就又变回「重复出现」了').toBe(0)

  // ② 反向:指针换到设置行,搜索行退回去。
  const settingsRow = settingsCap.closest('[data-slot="button"]') as HTMLElement
  await userEvent.hover(settingsRow)
  await settledOpacity(settingsCap, 1)
  await settledOpacity(searchCap, 0)

  // ③ 两态之间键帽一格不动。
  const hoverRects = [searchCap, settingsCap].map((c) => c.getBoundingClientRect())
  hoverRects.forEach((rect, i) => {
    expect(rect.left, '键帽不许在悬浮时换位置').toBeCloseTo(restRects[i].left, 1)
    expect(rect.width, '键帽不许在悬浮时改宽度').toBeCloseTo(restRects[i].width, 1)
  })
})

/**
 * 键盘那一半:纯键盘的人永远走不到 hover,若键帽只认指针,`⌘,` 对他们就等于不存在。
 *
 * 这条**必须实测**,不能按「类名写了就行」放过:Tailwind v4 对生成不出来的变体是**静默丢掉整条
 * utility** 的,而 `:focus-visible` 还叠了引擎自己的启发式(上一次输入是不是键盘)。两处任何一处
 * 不成立,`group-focus-visible/row:opacity-100` 就是一条死类 —— 而死类和生效的类在 DOM 上长得一样。
 */
it('#5707 键盘 Tab 停在那一行时键帽同样淡入(不止认指针)', async () => {
  mount()
  await until('both keycaps mounted', () => host.querySelectorAll('[data-slot="shortcut"]').length === 2)
  const [, settingsCap] = keycaps()
  const settingsRow = settingsCap.closest('[data-slot="button"]') as HTMLElement

  await settledOpacity(settingsCap, 0)

  // 走真键盘:先把焦点落到文档头,再 Tab 到这一行 —— `:focus-visible` 认的是「上一次输入是键盘」,
  // 直接 el.focus() 在鼠标模态下点不亮它。
  await userEvent.click(document.body)
  // 搜索行是 ⌘K 面板的入口(一颗按钮):点它焦点落在它身上,再 Tab 就到下一行。
  await page.getByTestId('sidebar-search-trigger').click()
  await userEvent.keyboard('{Tab}')
  await until('Tab reaches the settings row', () => document.activeElement === settingsRow)
  await settledOpacity(settingsCap, 1)
})
