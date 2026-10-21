import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { ChatComposer } from '@gugu/session-ui/react/components'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
// 主题层与同目录 composer-panel-family 同一套(理由见那份文件顶部)。
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

/**
 * @@@session-options-disabled 的判据 —— **看得见、真的选不了、看得出选不了、说得出为什么**。
 *
 * owner 2026-09-07 定的过渡态:会话中途还改不了模型/强度(咕咕代付的模型在 spawn 那一刻
 * 就绑定了这个 agent 进程连哪个网关、用谁的 key),但 UI 不能因此少一块 ——
 * 「为了保持 UI 的一致性,我们可以先展示出来,但置灰不可用」。
 *
 * ⚠️ 这条判据的重点**不是"它是灰的"**,是这四件事必须同时成立:
 *   ① 它在 —— 少了就退回 owner 说的"两个入口不一致";
 *   ② 点它**不发变更** —— 只要还能选中,那就是仓规里零容忍的假控件,而这一处的代价是
 *      「界面显示咕咕的模型、实际烧用户自己的 key」的错账;
 *   ③ 它**看起来就不能点** —— ② 单独成立时最坏:一行长得和能选的一模一样、点下去
 *      什么也不发生,用户只会以为程序坏了;
 *   ④ 它说得出为什么 —— owner 2026-08-21「选不了的那一头要留在原地并说明原因」。
 * 只判 ① 或只判"有 disabled 属性"会漏掉 ②,而 ② 才是会花钱的那一条。
 */
/**
 * ⚠️ 对照那条(`Sonnet`)必须是**能选且当前没被选中**的:拿"当前已选中的那条"做阴控,
 * 点它可能本来就不发变更(值没变),于是阴控会**因为错误的理由**通过 —— 那正是它该防的
 * 失败模式(判据/面板整体坏掉)会照样溜过去的样子。
 */
const MODELS = {
  'claude-haiku': { name: 'Haiku', description: '当前选中的那条' },
  'claude-sonnet': { name: 'Sonnet', description: '这条会话自己报的,能选' },
  'platform:glm-5.2': {
    name: '咕咕 GLM 5.2',
    description: '按积分计费',
    disabled: true,
    disabledReason: '咕咕提供的模型在会话启动时就定了 —— 中途切换需要重载,这个能力还在做。',
  },
}

const EFFORT_LOCK_REASON = '这条会话没报思考档位,所以中途还改不了。创建任务时可以选。'

/**
 * 能选的那份 —— 阴控用。
 *
 * ⚠️ **整份一起置灰,❌ 不做"只锁其中一档"的样本**:宿主那边就是整组一起挂的
 * (`acp-chat-panel.tsx` 对 resolved 目录里**每一档**都写同一个 `disabled` + 同一条原因),
 * 而 2026-09-17 起这个控件是一条滑杆 —— 一条连续的轴没有"跳过中间某一档"的表达方式。
 * 拿一份只锁一档的假样本来判,判的是产品到不了的状态,还会逼着实现去长一个没人用的分支。
 */
const EFFORTS = {
  low: { name: '低' },
  medium: { name: '中' },
  high: { name: '高' },
}

const LOCKED_EFFORTS = Object.fromEntries(
  Object.entries(EFFORTS).map(([id, option]) => [
    id,
    { ...option, disabled: true, disabledReason: EFFORT_LOCK_REASON },
  ])
)

let root: Root | null = null
let container: HTMLDivElement | null = null
const onModelChange = vi.fn()
const onEffortChange = vi.fn()

const panel = () => document.querySelector<HTMLElement>('[data-slot="combobox-content"]')

async function openPanel() {
  const trigger = document.querySelector('[data-testid="composer-model-trigger"]') as HTMLElement
  trigger.click()
  await until('model panel opens', () => panel() != null)
  await until('model panel lists options', () => panel()!.querySelectorAll('[role="option"]').length > 0)
}

/** 那一行的 DOM —— 按名字找,❌ 不按序数(序数会随分组顺序变)。 */
const rowByName = (name: string): HTMLElement | null => {
  const cell = [...(panel()?.querySelectorAll('[data-slot="composer-model-name"]') ?? [])].find(
    (el) => el.textContent?.trim() === name
  )
  return (cell?.closest('[role="option"]') as HTMLElement) ?? null
}

/**
 * 点一下并让 React 把这一轮事件处理完。
 * ⚠️ 这里的让步不是墙钟预算(#4357):选中与否在 click 的同步派发里就定了 ——
 * Base UI `ComboboxItem` 的 onClick 对 disabled 直接 return、否则同步 commitSelection,
 * 回调同步落到 `composer-model-menu.tsx` 的 onValueChange → onModelChange,中间没有定时器。
 */
async function clickAndSettle(el: HTMLElement) {
  el.click()
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * 滑杆的三层皮:刻度层 / 填充 / 圆钮。
 * ⚠️ 压暗**只**加在前两者上,圆钮始终满不透明 —— 它是唯一在说"现在停在哪一档"的那一笔,
 * 整颗控件一起压暗的话,锁住时它反倒成了最淡的东西。判据跟着这条走。
 */
const effortTicksWrap = () =>
  panel()?.querySelector<HTMLElement>('[data-slot="composer-effort-tick"]')?.parentElement ?? null
const effortIndicator = () =>
  panel()?.querySelector<HTMLElement>('[data-slot="composer-effort-indicator"]') ?? null
const effortThumb = () =>
  panel()?.querySelector<HTMLInputElement>('input[type="range"]')?.parentElement ?? null

/**
 * 圆钮**实际**有多淡。
 *
 * ⚠️ 必须把整条祖先链的 opacity 连乘起来,❌ 不能只读它自己那一个值 ——
 * `opacity` 是**组透明度**,压在祖先上会把整棵子树一起压暗,而
 * `getComputedStyle(圆钮).opacity` 只报圆钮自己声明的那个数,永远是 1。
 * 2026-09-17 就是这么漏掉一个 P0 的:轨道上挂着 `opacity: 0.55`(圆钮是轨道的子节点),
 * 圆钮实际被压到 0.55,而这条断言一路绿着放行。
 */
function effectiveOpacity(el: HTMLElement): number {
  let value = 1
  // ⚠️ 走到**这一行的根**为止,❌ 别一路走到浮层:Base UI 的弹层开场自己有一段
  // opacity 0→1 的淡入,量进去的话读到的是"拍到动画的哪一帧"(实测 0.51),
  // 与"这颗控件把自己压暗了多少"是两件事。
  for (
    let node: HTMLElement | null = el;
    node && !node.matches('[data-slot="composer-effort-row"]');
    node = node.parentElement
  ) {
    value *= Number(getComputedStyle(node).opacity)
  }
  return value
}

/** 滑杆那颗可交互的壳(`Slider.Control`)—— 置灰态、指针手势都在它身上。 */
const sliderControl = (): HTMLElement | null =>
  panel()
    ?.querySelector<HTMLElement>('[data-slot="composer-effort-indicator"]')
    ?.closest('div')?.parentElement ?? null

/**
 * 按**横向比例**点轨道 —— 用户调档位的动作就是这个。
 * ❌ 不点刻点元素:那一层是 `pointer-events: none`(只画点,手势归轨道),
 * Playwright 的命中检查会判"点不到"而超时。
 */
// ⚠️ 同理:滑杆的变更在 pointer 事件的同步派发里发出(disabled 时 SliderControl 的 pointerdown 直接 return),
// 末尾那次让步不是在等一件异步的事。
async function clickTrackAt(ratio: number) {
  const control = sliderControl()!
  const box = control.getBoundingClientRect()
  await page.elementLocator(control).click({
    position: { x: box.width * ratio, y: box.height / 2 },
    force: true,
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('会话里暂时改不了的选项:看得见 · 选不了 · 看得出 · 说得出为什么', () => {
  beforeEach(async () => {
    await page.viewport(1400, 800)
    onModelChange.mockReset()
    onEffortChange.mockReset()
    container = document.createElement('div')
    container.className = 'emlight gugu-skin bg-background'
    document.body.classList.add('emlight', 'gugu-skin')
    document.body.appendChild(container)
    root = createRoot(container)
    renderComposer(EFFORTS)
    await until(
      'composer model trigger mounted',
      () => document.querySelector('[data-testid="composer-model-trigger"]') != null
    )
  })

  /** 换一份档位表重渲染 —— 这颗 composer 是受控的,锁不锁只能由外面换。 */
  function renderComposer(
    effortOptions: Record<string, { name: string; disabled?: boolean; disabledReason?: string }>
  ) {
    root!.render(
      <SessionLocalizationProvider>
        <ChatComposer
          modelOptions={MODELS}
          selectedModel="claude-haiku"
          onModelChange={onModelChange}
          effortOptions={effortOptions}
          selectedEffort="medium"
          onEffortChange={onEffortChange}
          onSubmit={() => {}}
          onStop={() => {}}
        />
      </SessionLocalizationProvider>
    )
  }

  afterEach(() => {
    document.body.classList.remove('emlight', 'gugu-skin')
    root?.unmount()
    container?.remove()
    root = null
    container = null
  })

  it('置灰的模型行:在、点不动、看得出、带原因', async () => {
    await openPanel()

    const locked = rowByName('咕咕 GLM 5.2')
    // 对照取**未选中**的那条:选中的行自带底色/字重,拿它比透明度会把两件事混在一起。
    const open = rowByName('Sonnet')

    // ① 在
    expect(locked, '置灰的那条整个没渲染 —— 那正是 owner 说的"两个入口不一致"').not.toBeNull()
    // 阳控:能选的那条也得取到,否则下面的对比是拿 null 比 null。
    expect(open, '能选的那条没取到 —— 这个 fixture 本身坏了,下面的对比全部作废').not.toBeNull()

    // ④ 原因(先判,因为它比"点不动"更容易在重构里被顺手删掉)
    expect(
      locked!.getAttribute('title'),
      '置灰了却不说为什么 —— 用户看见一块灰的、无处可问(owner 2026-08-21)'
    ).toContain('重载')

    // ③ 看得出选不了。判的是**比能选的那条暗**(相对),❌ 不钉 0.5:
    //    哪天整族一起换透明度,钉死的数字会红,而那种红传递不出任何信息。
    const dim = Number(getComputedStyle(locked!).opacity)
    const normal = Number(getComputedStyle(open!).opacity)
    expect(
      dim,
      `置灰的行与能选的行一样显眼(${dim} vs ${normal})—— 那就成了"看着能点、点了没反应"`
    ).toBeLessThan(normal)

    // ② 真的点不动。⚠️ 判的是**回调没被调用**,不是"有 disabled 属性":
    //    属性在而事件仍然发得出去,是这类 bug 最常见的样子。
    await clickAndSettle(locked!)
    expect(
      onModelChange.mock.calls,
      '点了置灰的那条居然发出了模型变更 —— 这一处的代价是「界面显示咕咕的模型、实际烧用户自己的 key」'
    ).toEqual([])

    // 阴控:同一个面板里能选的那条,点了必须真的发 —— 否则上面那条"没发"是平凡真
    // (整个面板坏了、或者选择器根本没选中东西,也会"没发")。
    await clickAndSettle(open!)
    await until('the selectable row emits a model change', () => onModelChange.mock.calls.length > 0)
    expect(onModelChange.mock.calls.length).toBe(1)
  })

  it('置灰的思考档:在、点不动、看得出、带原因', async () => {
    // ── 阳性:整条轴锁住 ────────────────────────────────────────────────────────
    renderComposer(LOCKED_EFFORTS)
    await openPanel()

    const row = panel()!.querySelector('[data-slot="composer-effort-row"]')
    expect(row, '强度那一段整个没渲染 —— 会话里应当"可见",只是暂时不可选').not.toBeNull()

    const locked = sliderControl()
    expect(locked, '滑杆没渲染').not.toBeNull()

    // ④ 说得出为什么(先判:它比"点不动"更容易在重构里被顺手删掉)。
    //   两处都要有:鼠标停在轨道上、以及停在读数上 —— 用户的指针多半落在后者。
    expect(locked!.getAttribute('title'), '轨道置灰了却不说为什么').toContain('改不了')
    expect(
      panel()!.querySelector('[data-slot="composer-effort-value"]')!.getAttribute('title'),
      '读数那头也得说得出为什么 —— 指针多半停在这儿'
    ).toContain('改不了')

    // ② 真的动不了。⚠️ 判的是**回调没被调用**,不是"有 disabled 属性":
    //    属性在而事件仍然发得出去,是这类 bug 最常见的样子。
    //    ❌ 也不能只点一下轨道中点:那恰好是当前档附近,不变值本来就不发。往最右端点。
    await clickTrackAt(0.95)
    expect(
      onEffortChange.mock.calls,
      '拖动置灰的滑杆居然发出了变更 —— 界面说改了,会话那头没有'
    ).toEqual([])

    // 键盘那条路同样要堵死 —— 滑杆的方向键是另一个入口,`disabled` 漏在样式层时它照样能动。
    const input = panel()!.querySelector<HTMLInputElement>('input[type="range"]')!
    input.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(onEffortChange.mock.calls, '方向键绕过了置灰').toEqual([])

    // ③ 看得出动不了(相对判暗 —— ❌ 不钉数值:哪天整族一起换透明度,钉死的数字会红,
    //    而那种红传递不出任何信息)。对照是同一颗控件在**没锁**时的样子。
    //    量的是轨道那两层,不是整颗控件,理由见 effortTicksWrap 抬头。
    const dimTicks = Number(getComputedStyle(effortTicksWrap()!).opacity)
    const dimFill = getComputedStyle(effortIndicator()!).backgroundColor
    const dimKnob = effectiveOpacity(effortThumb()!)

    // ── 阴性对照:同一颗控件、没锁 ──────────────────────────────────────────────
    // ⚠️ 先把面板收起再换 fixture:`openPanel()` 点的是同一颗触发器,面板开着时那一下
    // 是**关**,于是下面量到的还是上一轮那颗控件(0.5 vs 0.5,断言因为错误的理由而红)。
    await userEvent.keyboard('{Escape}')
    await until('model panel closes', () => panel() === null)
    onEffortChange.mockReset()
    renderComposer(EFFORTS)
    await openPanel()

    const open = sliderControl()!
    const normalTicks = Number(getComputedStyle(effortTicksWrap()!).opacity)
    const normalFill = getComputedStyle(effortIndicator()!).backgroundColor
    expect(
      dimTicks,
      `置灰的刻度与能用的一样显眼(${dimTicks} vs ${normalTicks})—— 鼠标还是手型,那是个假控件`
    ).toBeLessThan(normalTicks)
    // 填充**换色**(强调色 → 中性灰)才是把"锁住了"与"你调到了这里"分开的那一笔:
    // 只靠一层半透明的话,"锁住"与"一档都没选"在屏幕上几乎是同一张图。
    expect(dimFill, `锁住时填充仍是强调色(${dimFill})—— 那还在说"你调到了这里"`).not.toBe(
      normalFill
    )
    expect(
      dimKnob,
      '锁住时连圆钮也压暗了 —— 当前档位就没人说得出了(祖先链上任何一层挂 opacity 都算)'
    ).toBe(1)
    expect(open.getAttribute('title'), '没锁的时候不该挂"改不了"的说明').toBeNull()

    // 阴控必须真的发得出去 —— 否则上面那条"没发"是平凡真(面板整体坏掉也会"没发")。
    await clickTrackAt(0.95)
    await until('the unlocked slider emits an effort change', () => onEffortChange.mock.calls.length > 0)
  })
})
