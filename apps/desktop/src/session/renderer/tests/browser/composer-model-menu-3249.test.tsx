import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { i18n } from '@/i18n'
import { ChatComposer } from '@gugu/session-ui/react/components'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { composerModelOptions } from '@renderer/features/sessions/session-config/platform-model-options'
import { modelProviderIcon } from '@renderer/features/sessions/session-config/model-provider-icon'
// ⚠️ 主题层必须和真实入口(`session/renderer/embedded.tsx`)加载同一套:
// `--em-surface-*` 那一族是**上下文 token**,由 surfaces 级联在主题层里绑定。少引它们的话,
// 弹层里所有「选中/hover 底色」都解析成空 → 退回透明,渲出来是一片没有选中态的灰白。
// 实测:只引 tokens+index 时 `--em-surface-selected` 读出来是空串,而 `--em-foreground` 有值。
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

// #3249 owner:「我点完这个预期应该是收回这个选模型的框,但是现在没回收,这个问题得解决」
//
// **2026-09-05 载体换了,契约没换。** 模型面板照 assistant-ui 的
// 「With search, provider filters + groups」重做,从 DropdownMenu 两级子菜单变成 Combobox
// 一层搜索面板(owner 令严格套用)。于是:
//   - 旧根因(Base UI `Menu.RadioItem` 的 `closeOnClick` 默认 false)已经不适用;
//   - 新实现里「选完收起」是调用点显式 `setModelPanelOpen(false)` —— 一句可以被删掉的代码,
//     所以更需要这条守卫。
//
// ⚠️ 推理强度那条是**刻意偏离上游**的:assistant-ui 那版选完档位不关面板(原文
// the picker stays open so you can compare levels),而 #3249 明写「推理强度那组同样收起
// (与模型同一个毛病,别只修一半)」。套上游是套形状,不是套掉 owner 修过的 bug。
//
// 这条只能用**真 Chromium + 真 Base UI 弹层**判:
//   - 类型检查照不出 —— 少调一次 setState 不是类型错误。
//   - jsdom 照不出 —— 弹层的开合由 Base UI 的浮层状态机驱动,没有真实排版和真实指针就没有它。
//
// 判据是「面板从 DOM 里消失」,不是「onModelChange 被调用了」—— 后者在坏版本里同样成立
// (值选中了,框不收),正是 owner 报的那个样子。

/**
 * fixture 走**产品那条真管线**(`composerModelOptions` + `modelProviderIcon`),不是手捏一份
 * 近似的。
 *
 * ⚠️ 这一条是上一轮的教训:手捏的 fixture 只有两档推理强度、也没有厂商图标,于是取证图拍出来
 * 是「产品长这样」的假象,而产品其实 codex 六档、每行带 logo。**fixture 不同形 ⇒ 取证图不是
 * 产品的样子**,与「主题层没引全」是同一类失真,只是这次失真在数据侧。
 *
 * 覆盖面刻意选成「同一家厂商同时出现在两档里」(OpenAI 既有你自己的、也有咕咕代付的):
 * 那是两级分类唯一会被搞错的地方 —— 一级(厂商)必须把它们归到同名组头,二级(谁的)必须把它们
 * 切成两段。合成一段就意味着「按积分计费」盖到了不花积分的那几条上。
 */
const buildModels = () =>
  composerModelOptions(
    {
      // ⚠️ 这一条**认不出厂商**,而且是产品里真实存在的第一条:claude 的模型目录首项就叫
      // 「Default (recommended)」(实机取证)。它一进 fixture,「认不出厂商的行怎么排」
      // 就从一个假想问题变成必须回答的问题 —— 上一版实机上它的名字比其余 18 行左移 22px。
      default: { name: 'Default (recommended)' },
      'gpt-5.6-codex': { name: 'gpt-5.6-codex', description: '400K 上下文' },
      'gpt-5.6-sol': { name: 'GPT-5.6 Sol', description: '400K 上下文' }
    },
    [
      {
        id: 'glm-5.2',
        displayName: 'GLM 5.2',
        protocol: 'anthropic-messages',
        creditMultiplier: 0.55,
        contextWindow: 200_000,
        reasoningEfforts: null
      },
      {
        id: 'gpt-5.6-sol',
        displayName: 'GPT-5.6 Sol',
        protocol: 'openai-responses',
        creditMultiplier: 2.5,
        contextWindow: 200_000,
        reasoningEfforts: null
      }
    ],
    { ownTierLabel: '你的 Codex 模型', icon: modelProviderIcon }
  )

/**
 * codex 插件声明的**真实**档位表(`packages/session-plugins/src/agents/impl/codex/index.ts`)。
 * ❌ 别缩成两档:owner 2026-09-05「实际的 thinking 水平也不可能只有两档吧」——
 * 缩过的 fixture 会让「这一排放不放得下」这个问题在取证图上根本不出现。
 */
const EFFORTS = {
  low: { name: '低' },
  medium: { name: '中' },
  high: { name: '高' },
  xhigh: { name: '极高' },
  max: { name: '最高' },
  ultra: { name: '超量' }
}

const LONG_EFFORTS = {
  default: { name: 'Default' },
  low: { name: 'Low' },
  medium: { name: 'Medium' },
  high: { name: 'High' },
  xhigh: { name: 'Xhigh' },
  max: { name: 'Max' },
  ultracode: { name: 'UltraCode' }
}

let MODELS: ReturnType<typeof buildModels>
let previousLanguage = 'zh-CN'
let root: Root | null = null
let container: HTMLDivElement | null = null
const onModelChange = vi.fn()
const onEffortChange = vi.fn()

/**
 * 这个面板在 DOM 里的痕迹 —— 收起后必须一个都不剩。
 * ⚠️ 只数 combobox 的 content 槽位,**不数**全文档的 listbox 角色节点:composer 还挂着
 * 斜杠命令与 @ 提及两个面板(也是 combobox),数全量会让这条断言被无关 UI 拖红。
 * 这里的 composer 没传 agentOptions,所以文档里此刻只可能有模型这一个 combobox 浮层。
 */
const openMenuParts = (): number =>
  document.querySelectorAll('[data-slot="combobox-content"]').length

describe('#3249 composer 模型下拉', () => {
  /** 换一个选中模型重渲染 —— 这颗 composer 是受控的,选中值只能由外面换。 */
  const renderComposer = (
    selectedModel: string,
    effort: { selected?: string; default?: string } = { selected: 'medium' },
    effortOptions: Record<string, { name: string }> = EFFORTS
  ) => {
    root!.render(
      <SessionLocalizationProvider>
        <ChatComposer
          modelOptions={MODELS}
          selectedModel={selectedModel}
          onModelChange={onModelChange}
          effortOptions={effortOptions}
          selectedEffort={effort.selected}
          onEffortChange={onEffortChange}
          defaultEffort={effort.default}
          onSubmit={() => {}}
          onStop={() => {}}
        />
      </SessionLocalizationProvider>
    )
  }

  beforeEach(async () => {
    // ⚠️ 语言必须**钉死**,不能只在注释里假定 en-US。
    // 2026-09-05 合进 dev 后这三条在 mac1-ci-09 上红了:同一棵树在 PR 那轮是绿的,差别只是
    // 跑在哪个 runner —— 槽位的系统语言不同,`translateSessionMessage` 解析出的组头就不同
    // (期望 `Models provided by Gugu · billed in credits`,实得「咕咕提供的模型 · 按积分计费」)。
    // 读环境语言的断言判不了它声称要判的那件事,与兄弟守卫 composer-settings-row-layout 同一处理。
    previousLanguage = i18n.language
    await i18n.changeLanguage('en-US')
    // ⚠️ fixture 必须在**改完语言之后**构造:平台那一级的组头是 `composerModelOptions` 调
    // `translateSessionMessage` 当场算出来的,写成模块顶层的 const 会把 import 那一刻的语言烤进去,
    // 于是 beforeEach 里再改语言也来不及。
    MODELS = buildModels()
    await page.viewport(1100, 700)
    onModelChange.mockReset()
    onEffortChange.mockReset()
    container = document.createElement('div')
    // 主题变量只定义在 .emlight / .emdark 下;弹层 portal 到 body 时得有带主题类的祖先,
    // 否则语义色全失效(与 composer-agent-selector 同一处理)。
    container.className = 'emlight gugu-skin bg-background'
    // ⚠️ 主题类还得**同时挂到 body**:弹层 portal 到 body,不在 container 里面 ——
    // 只挂 container 的话,语义色变量在弹层那棵子树上取不到,面板会渲成一片灰白的半透明
    // (第一版取证图就是这么拍出来的,看着像坏了,其实是这个测试的主题根没铺到)。
    document.body.classList.add('emlight', 'gugu-skin')
    document.body.appendChild(container)
    root = createRoot(container)
    renderComposer('platform:glm-5.2')
    await until(
      'model trigger mounted',
      () => document.querySelector('[data-slot="composer-model"] [data-slot="combobox-trigger"]') != null
    )
  })

  afterEach(async () => {
    await i18n.changeLanguage(previousLanguage)
    document.body.classList.remove('emlight', 'gugu-skin')
    root?.unmount()
    container?.remove()
    root = null
    container = null
  })

  /**
   * 打开模型面板。**没有二级了** —— 上游那版是一层:搜索框 → 厂商药丸 → 分组清单 → 底部 Thinking 行。
   */
  async function openPanel(): Promise<void> {
    // @@@6301 前提:面板此刻是关着的。触发器是开关 —— 面板已开时再点一下是**关掉**它,而关闭动画期间
    // 弹层还在 DOM 里,下面几条轮询会照样满足,调用方于是在一个正在消失的面板上量东西。
    expect(openMenuParts(), 'openPanel() on an already-open panel would toggle it shut').toBe(0)
    // ⚠️ 用 testid 不用 `getByRole('button', { name: 当前模型名 })`:
    //  · 触发器的 role 现在是 `combobox`(上游 anatomy 就是 role="combobox"),不再是 button;
    //  · 它的可访问名是**当前模型名**,会随选择变化 —— 拿动态值当锚点,选完一次就找不着了。
    await page.getByTestId('composer-model-trigger').click()
    await until('model panel open', () => openMenuParts() === 1)
    await until(
      'model panel lists options',
      () => document.querySelectorAll('[data-slot="combobox-content"] [role="option"]').length > 0
    )
    // @@@6301 「打开」还包括打开时的**初始焦点落定**:Combobox 在弹层出现后的下一拍才把焦点交给搜索框。
    // 不等它,后面的 `thumbInput.focus()` 会被这次迟到的交接抢走,方向键落进搜索框 —— 回调一次都不发。
    // mac1 实测 50 次里 6 次(按键前焦点在滑杆 50/50,按键后在搜索框 43/50)。等的是这个事实,❌ 加时钟。
    // 目录为空时没有搜索框,也就没有这次交接。
    await until('initial focus lands on the search box', () => {
      const search = document.querySelector('[data-slot="combobox-content"] [data-testid="composer-model-search"]')
      return !search || document.activeElement === search
    })
  }

  /**
   * 清单里此刻**可见**的模型行名字。搜索与厂商过滤都靠它判。
   * ⚠️ 读的是名字那一格,不是整行的 textContent:一条是两段式,整行文本会把第二行
   * (「相对倍率 ×0.55」之类)连在名字后面,断言就得跟着抄一遍说明文案。
   */
  const visibleOptions = (): string[] =>
    [
      ...document.querySelectorAll(
        '[data-slot="combobox-content"] [data-slot="composer-model-name"]'
      )
    ].map((el) => el.textContent?.trim() ?? '')

  const sameList = (actual: string[], expected: string[]): boolean =>
    JSON.stringify(actual) === JSON.stringify(expected)

  /** 组头此刻是什么 —— 组头承载的是**一级分类**(这条是谁的)。 */
  const visibleGroups = (): string[] =>
    [
      ...document.querySelectorAll('[data-slot="combobox-content"] [data-slot="combobox-label"]')
    ].map((el) => el.textContent?.trim() ?? '')

  it('选一个别的模型 → 整个面板收起', async () => {
    await openPanel()

    await page.getByText('gpt-5.6-codex', { exact: true }).click()

    expect(onModelChange.mock.calls).toEqual([['gpt-5.6-codex']])
    await until('model panel closed', () => openMenuParts() === 0)
  })

  it('点已经选中的那条也收起(owner 截图里点的就是这条)', async () => {
    await openPanel()

    await page.getByText('GLM 5.2', { exact: true }).click()

    // 值没变(本来就是它),但框必须回收 —— 坏版本在这条上表现得最刺眼:
    // 用户点了一下"确认",界面纹丝不动。
    // ⚠️ 这条最容易在换载体时悄悄坏掉:「选完收起」挂在 onValueChange 上,而 Combobox
    // **可能对同值不回调** —— 那样点当前这条就什么都不发生,正好回到 owner 报的原样。
    await until('model panel closed', () => openMenuParts() === 0)
  })

  it('触发器剥掉括号,清单里保留全名 —— 渐进披露,不是把信息删掉', async () => {
    // owner 2026-09-07:「一般括号里的信息确实是可以忽略的,或者渐进披露的」。
    // 括号里是**规格**不是身份:常驻那颗按钮回答「我现在用的是谁」,要短;
    // 规格是打开清单挑的时候才要分辨的。
    //
    // ⚠️ 这条必须**两头都判**。只判触发器变短的话,把清单也一起剥掉照样绿 ——
    // 而那正是危险的那一种坏法:claude 目录里 `Opus` 与 `Opus (1M context)` 同时存在,
    // 清单一剥就是两条一模一样的、选不出来。fixture 里 `Default (recommended)` 就是
    // claude 目录的真实首项(实机取证),不是为这条判据捏的。
    await openPanel()
    expect(visibleOptions(), '清单里不该剥括号 —— 那是用户要分辨规格的地方').toContain(
      'Default (recommended)'
    )

    // ⚠️ 不能"点一下那条然后看触发器变没变":这颗 composer 是**受控**的,`selectedModel`
    // 是固定 prop、`onModelChange` 只是个 spy,点完触发器上的值根本不会动
    // (第一版就是这么写的,读出来永远是 fixture 里那条 `Gugu GLM 5.2`)。
    // 要判触发器,就得**真的把选中值换成带括号的那条**再看它怎么渲染。
    // `composerModelOptions` 的返回类型带 `| null`(没有可用模型时),所以先取窄。
    const catalog = MODELS ?? {}
    const parenthesized = Object.keys(catalog).find((id) =>
      catalog[id]?.name.includes('(recommended)')
    )
    expect(parenthesized, 'fixture 里那条带括号的模型不见了 —— 这条判据失去了它的样本').toBeTruthy()

    renderComposer(parenthesized!)

    // 读**名字那一格**,不是整颗触发器:后者的文本会把强度档("中")粘在名字后面。
    await until(
      'trigger label drops the parenthesized spec',
      () =>
        document
          .querySelector<HTMLElement>(
            '[data-slot="composer-model"] [data-slot="composer-model-trigger-label"]'
          )
          ?.innerText?.trim() === 'Default'
    )
  })

  /**
   * 「思考」那一段的 DOM —— 2026-09-17 起是一条**离散滑杆**,不再是一排单选药丸
   * (owner 要求重做思考档位控件)。
   * 下面这几条守的是同样几件事,只是换了控件类型去问。
   */
  const effortRow = (): HTMLElement =>
    document.querySelector<HTMLElement>('[data-slot="composer-effort-row"]')!
  const effortTicks = (): HTMLElement[] => [
    ...effortRow().querySelectorAll<HTMLElement>('[data-slot="composer-effort-tick"]')
  ]
  const effortReadout = (): string | undefined =>
    document.querySelector<HTMLElement>('[data-slot="composer-effort-value"]')?.textContent?.trim()

  /**
   * 点在某一档的刻点上。
   *
   * ⚠️ 不能 `getByTestId(tick).click()`:刻点那一层是 `pointer-events: none`(它只是画点,
   * 手势归轨道),Playwright 的命中检查会判定"点不到"而超时。所以按**坐标**点轨道本身 ——
   * 这也正是用户的动作:点轨道上那个位置,滑杆就跳到最近的一档。
   */
  const clickEffortAt = async (id: string) => {
    const tick = document.querySelector<HTMLElement>(`[data-testid="composer-effort-${id}"]`)!
    const control = effortRow().querySelector<HTMLElement>('[data-slot="composer-effort-indicator"]')!
      .closest('div')!.parentElement!
    const box = control.getBoundingClientRect()
    const dot = tick.getBoundingClientRect()
    await page.elementLocator(control).click({
      position: { x: dot.left + dot.width / 2 - box.left, y: box.height / 2 }
    })
  }

  it('思考那一段同样收起(与模型同一个毛病,别只修一半)', async () => {
    await openPanel()

    await clickEffortAt('xhigh')

    expect(onEffortChange.mock.calls).toEqual([['xhigh']])
    // ⚠️ 刻意偏离上游(它选完档位**不关**,让你比档位)。删掉调用点那句
    // `setModelPanelOpen(false)`,这条必红 —— 那正是它存在的意义。
    // ⚠️ 收在 `onValueCommitted` 而不是 `onValueChange`:拖动时每跨一格都关一次面板,
    //    手还没松控件就没了。改回 onValueChange,这条仍绿而手感坏掉 —— 所以下面那条拖动用例
    //    才是它的搭档。
    await until('model panel closed', () => openMenuParts() === 0)
  })

  it('键盘也调得动档位 —— 左右键是滑杆的手,上下键仍然归模型清单', async () => {
    await openPanel()

    // 方向键直接发给圆钮底下那个原生 range(Base UI 的键盘处理挂在它上面)。
    const thumbInput = effortRow().querySelector<HTMLInputElement>('input[type="range"]')!
    thumbInput.focus()
    await userEvent.keyboard('{ArrowRight}')

    // fixture 当前是 medium(第 2 档),右一格是 high。
    await until('ArrowRight reports high', () => onEffortChange.mock.calls.at(-1)?.[0] === 'high')
    expect(onEffortChange.mock.calls.at(-1)).toEqual(['high'])

    // ⚠️ 一次按键**只许发一次**。Base UI 的方向键会同时触发 change 与 commit 两个回调,
    // 两边都发就是重复调用 —— 而「和当前档相同就跳过」那道守卫拦不住它:同一拍里
    // prop 还没回传,组件看到的仍是旧档(2026-09-18 自审时发现,当时两边都发)。
    expect(onEffortChange.mock.calls, '一次按键发了不止一次').toEqual([['high']])

    // ⚠️ 键盘这条路**不许跟着关面板**。Base UI 的方向键每按一下都会 commit,
    // 若照指针那条一样关掉,键盘用户一次只调得动一格 —— 六档从最低调到最高要开五次面板。
    // 药丸那版一次按键 = 一个决定,滑杆的心智模型是"滑到想要的位置",这是换控件带进来的
    // 新毛病(2026-09-17 找茬审查实测:按一下 ArrowRight 面板当场关闭)。
    expect(openMenuParts(), '键盘按一下面板就关了 —— 剩下五档得重新开五次').toBe(1)

    // 指针那条照旧收起 —— #3249 要的就是这个,别把它一起修没了。
    clickEffortAt('max')
    await until('model panel closed', () => openMenuParts() === 0)
  })

  it('一档都没选时,读屏器听到的与看到的是同一件事', async () => {
    // 看得见的人读到「默认 / 未指定,由引擎自己决定」;而 aria-valuetext 留空的话,
    // 读屏器会退回去念 aria-valuenow —— 也就是量程最小值 0 = **最低档**。
    // 视觉那侧花了压暗 + 改文案两笔去区分的事,无障碍这侧一笔都不能少。
    renderComposer('platform:glm-5.2', {})
    await openPanel()

    const input = effortRow().querySelector<HTMLInputElement>('input[type="range"]')!
    expect(input.getAttribute('aria-valuenow'), '未选时圆钮停在最低档那一格').toBe('0')
    expect(
      input.getAttribute('aria-valuetext'),
      'aria-valuetext 是空的 —— 读屏器会退回去念 0,听成"最低档"'
      // ⚠️ 这个文件把语言**钉死**成 en-US(见 beforeEach 那段),所以断言照英文那份走。
    ).toBe('Default')

    // 说明行要能被读屏器取到:它挂在外层 div 的 title 上,读屏器取不到;
    // 锁住时 input 还是 disabled,更取不到。所以显式 aria-describedby 指过去。
    const describedBy = input.getAttribute('aria-describedby')
    expect(describedBy, '说明行没挂到圆钮上').toBeTruthy()
    expect(
      document.getElementById(describedBy!)?.textContent,
      'aria-describedby 指向了一个不存在的节点'
    ).toBe('Default')
  })

  it('「减少动态效果」真的关得掉 —— ❌ 不许被高权重选择器架空', async () => {
    // 2026-09-17 踩过:位置过渡挂到 `:focus-within`(权重 0,3,0)之后,
    // `@media (prefers-reduced-motion)` 里那条裸类规则(0,1,0)**永远赢不了** ——
    // 媒体查询不加权重,于是"减少动态效果"被悄悄架空。
    // 改法是让时长走自定义属性:元素**自己**声明的值压过从祖先继承来的,与权重无关。
    // 这条用不到媒体模拟就能判 —— 媒体查询做的事就是在这两个元素上声明那两个变量。
    await openPanel()

    const thumb = effortRow().querySelector<HTMLInputElement>('input[type="range"]')!
      .parentElement!
    const indicator = effortRow().querySelector<HTMLElement>(
      '[data-slot="composer-effort-indicator"]'
    )!
    thumb.focus() // 把 :focus-within 那道门打开,过渡此刻是开着的
    await until('focus-within opens the transition', () => getComputedStyle(thumb).transitionDuration !== '0s, 0s')

    for (const el of [thumb, indicator]) {
      el.style.setProperty('--composer-effort-move', '0ms')
      el.style.setProperty('--composer-effort-press', '0ms')
    }
    for (const [el, name] of [
      [thumb, '圆钮'],
      [indicator, '填充']
    ] as const) {
      expect(
        getComputedStyle(el)
          .transitionDuration.split(',')
          .every((d) => Number.parseFloat(d) === 0),
        `${name}在「减少动态效果」下仍然有过渡 —— 那道门把它架空了`
      ).toBe(true)
    }
  })

  it('触发器与面板说的是同一档 —— 模型默认档也算"当前生效"', async () => {
    renderComposer('platform:glm-5.2', { default: 'xhigh' })

    await until(
      'trigger shows the default effort',
      () => document.querySelector<HTMLElement>('[data-slot="composer-effort"]')?.textContent?.trim() === '极高'
    )

    await openPanel()

    // ① 读数说的是同一档。
    await until('panel readout shows the default effort', () => effortReadout() === '极高')
    // ② 圆钮停在那一档上 —— 判的是 `aria-valuetext`(读屏器听到的),不是序号。
    const thumbInput = effortRow().querySelector<HTMLInputElement>('input[type="range"]')!
    expect(thumbInput.getAttribute('aria-valuetext')).toBe('极高')
    // ③ 走过的那几档刻点是"填过"的,后面的不是 —— 这条钉住"深浅"那条轴真的画出来了。
    // ⚠️ **当前那一档自己不算**:它的刻点正压在圆钮底下(刻点与圆心对齐),给一个看不见的
    // 点上色只会在改实现时误导人。上游实测第 4/5 档也正好是三个亮点 + 一个灰点。
    const filled = effortTicks().map((tick) => tick.hasAttribute('data-filled'))
    expect(filled).toEqual([true, true, true, false, false, false])
  })

  it('思考有几档、按什么顺序,都由 harness 说了算', async () => {
    await openPanel()

    // owner 2026-09-05:「实际的 thinking 水平也不可能只有两档吧」。codex 真声明六档,
    // 而上游 demo 的 Low/Med/High 只是它的示例取值。
    // 阴性对照在同一条里:`ultra` 是最后一档,它在的话就说明没有被按三档裁掉。
    expect(effortTicks().map((tick) => tick.dataset.testid)).toEqual([
      'composer-effort-low',
      'composer-effort-medium',
      'composer-effort-high',
      'composer-effort-xhigh',
      'composer-effort-max',
      'composer-effort-ultra'
    ])
    // 滑杆的量程 = 档位数 - 1。少一格就意味着最后一档拖不到。
    const thumbInput = effortRow().querySelector<HTMLInputElement>('input[type="range"]')!
    expect(thumbInput.max).toBe('5')
  })

  it('刻点与圆钮圆心逐档对齐,且七档也只占一行', async () => {
    await openPanel()

    // ── ① 刻点等距,且首尾各让出半个圆钮 ────────────────────────────────────────
    // `thumbAlignment="edge"` 下圆钮圆心走的是"缩进半个圆钮"之后的那一段。刻点必须摊在
    // **同一段**里,否则两端各差半个圆钮 —— 圆钮停在一档上,点却在旁边。
    const indicator = effortRow().querySelector<HTMLElement>(
      '[data-slot="composer-effort-indicator"]'
    )!
    const track = indicator.parentElement!.getBoundingClientRect()
    const centers = effortTicks().map((tick) => {
      const box = tick.getBoundingClientRect()
      return box.left + box.width / 2 - track.left
    })
    const gaps = centers.slice(1).map((c, i) => c - centers[i])
    expect(Math.max(...gaps) - Math.min(...gaps), `刻点间距: ${gaps.join(', ')}`).toBeLessThan(0.5)

    // ② 当前档的圆钮圆心 == 该档刻点;填充**恰好**收在圆钮**左缘**。
    //   后一条是照 owner 给的截图**逐行**量出来的:上游蓝色右缘沿圆钮的圆弧凹进去
    //   (295/291/288/286/285/284/284/285/287/289/292 设备像素),与白色左缘恒隔 1–2 像素 ——
    //   也就是填充铺到圆钮**底下**、由圆钮那道环切出一条发丝缝。截在圆钮左缘的话,
    //   圆头与正圆之间会留下一块梭形空白。
    const thumb = effortRow().querySelector<HTMLInputElement>('input[type="range"]')!
      .parentElement!.getBoundingClientRect()
    const thumbCenter = thumb.left + thumb.width / 2 - track.left
    expect(Math.abs(thumbCenter - centers[1]), '圆钮没停在当前档的刻点上').toBeLessThan(0.5)
    expect(
      Math.abs(indicator.getBoundingClientRect().right - track.left - thumbCenter),
      '填充末端没有收在圆钮圆心上 —— 收早了圆钮左边会露出一块梭形空白(owner 2026-09-17 圈的就是它)'
    ).toBeLessThan(0.5)

    // ③ 圆钮**横向**不许探出轨道两端 —— edge 对齐没生效时,最小档会有半个圆钮挂在面板外面。
    //   (纵向是**故意**探出的:圆钮 28 压在 24 的轨道上,上下各 2px,见 css 抬头的实测表。)
    expect(thumb.left).toBeGreaterThanOrEqual(track.left - 0.5)
    expect(thumb.right).toBeLessThanOrEqual(track.right + 0.5)
    expect(thumb.height, '圆钮没比轨道高 —— 那就退回"开关拨钮"的样子了').toBeGreaterThan(
      track.height
    )

    // ── ④ 七档不换行、不长高 ──────────────────────────────────────────────────
    // 这正是换掉分段药丸的理由:七档药丸在 264px 里要摊成三行方格(旧实现实测 112.6px 高),
    // 而滑杆多一档只是多一个点。❌ 别让它随档位数长高,那条毛病就回来了。
    // ⚠️ 用 `offsetHeight` 不用 `getBoundingClientRect().height`:Base UI 的浮层开场有一段
    // `scale(0.95)` 动画,rect 会把那 0.95 一起量进去(实测 73 量成 69.35),于是这条断言
    // 判的其实是"两次测量赶上动画的哪一帧"。offsetHeight 是布局高度,不吃 transform。
    const sixRowHeight = effortRow().offsetHeight
    expect(effortRow().scrollWidth).toBeLessThanOrEqual(effortRow().clientWidth)

    // 重渲染是同一个组件实例:面板**仍然开着**,直接等它换上七档。❌ 再 openPanel() —— 那一下点的是
    // 开关,会把它关掉(#6301:旧写法正是在关闭动画那几帧里量到的)。
    renderComposer('platform:glm-5.2', { selected: 'ultracode' }, LONG_EFFORTS)
    await until('slider re-renders with seven ticks', () => effortTicks().length === 7)
    expect(openMenuParts(), '重渲染后面板应仍开着').toBe(1)
    expect(effortReadout()).toBe('UltraCode')
    expect(effortRow().scrollWidth).toBeLessThanOrEqual(effortRow().clientWidth)
    expect(
      effortRow().offsetHeight,
      '档位一多这一段就长高了 —— 那是旧分段药丸的毛病,滑杆不该有'
    ).toBe(sixRowHeight)
  })

  it('面板一开,圆钮就在当前档上 —— 不许从最左滑过去', async () => {
    // 2026-09-17 实测过的一次真事故:给圆钮加了 `inset-inline-start` 过渡之后,Base UI 头两帧
    // 还没量出圆钮宽度、位置是 0,过渡就把这段库内部的布局补正演成了入场动画 ——
    // 逐帧 13ms ctr=0 → 32ms 22.4 → 65ms 48.9 → 164ms 61.0。用户看到的是"每开一次面板
    // 都重新调一遍档位"。修法是把位置过渡挂到 `:focus-within` 上(见 css)。
    //
    // 判据取**第一帧**:那一帧就得在位上。⚠️ 用比值不用绝对值 —— 浮层开场自己有一段
    // scale(0.95),首帧量到的是 0.95 倍的坐标,钉绝对像素会判成"偏了 3px"。
    await openPanel()
    const first = await new Promise<{ ratio: number; ctr: number }>((done) => {
      requestAnimationFrame(() => {
        const indicator = effortRow().querySelector<HTMLElement>(
          '[data-slot="composer-effort-indicator"]'
        )!
        const track = indicator.parentElement!.getBoundingClientRect()
        const thumb = effortRow()
          .querySelector<HTMLInputElement>('input[type="range"]')!
          .parentElement!.getBoundingClientRect()
        const ctr = thumb.left + thumb.width / 2 - track.left
        // 当前档是 medium(第 2 档,共 6 档)⇒ 圆心该落在可走行程的 1/5 处。
        done({ ratio: (ctr - thumb.width / 2) / (track.width - thumb.width), ctr })
      })
    })
    expect(first.ratio, `首帧圆钮在 ${first.ctr.toFixed(1)}px,不在第 2 档上`).toBeCloseTo(0.2, 2)
  })

  it('只有一档时不画滑杆 —— 那是一条拖不动的死轨道', async () => {
    renderComposer('platform:glm-5.2', { selected: 'only' }, { only: { name: '唯一档' } })
    await openPanel()

    // 读数还在(用户仍然看得见当前是哪一档),轨道没了。
    expect(effortReadout()).toBe('唯一档')
    expect(
      effortRow().querySelector('[data-slot="composer-effort-indicator"]'),
      '一档也画出了滑杆 —— 量程会被撑成 0→1,右半条拖得动却永远弹回'
    ).toBeNull()
  })

  it('复位钮:改过才出现,点了发送声明的默认档', async () => {
    // ① 当前就是模型默认档 —— 没有可撤的东西,❌ 不许画一枚点了什么也不发生的按钮。
    renderComposer('platform:glm-5.2', { selected: 'high', default: 'high' })
    await openPanel()
    expect(document.querySelector('[data-testid="composer-effort-reset"]')).toBeNull()
    await userEvent.keyboard('{Escape}')
    await until('model panel closed', () => openMenuParts() === 0)

    // ② 改过了 —— 按钮出现,点了发送目录里的默认档 id。
    renderComposer('platform:glm-5.2', { selected: 'max', default: 'high' }, LONG_EFFORTS)
    await openPanel()
    await page.getByTestId('composer-effort-reset').click()
    expect(onEffortChange.mock.calls).toEqual([['high']])
    await until('model panel closed', () => openMenuParts() === 0)
  })

  it('复位钮使用目录提供的 default 项,回到该项后隐藏', async () => {
    renderComposer('platform:glm-5.2', { selected: 'low' }, LONG_EFFORTS)
    await openPanel()
    await page.getByTestId('composer-effort-reset').click()
    expect(onEffortChange.mock.calls).toEqual([['default']])
    await until('model panel closed', () => openMenuParts() === 0)

    renderComposer('platform:glm-5.2', { selected: 'default' }, LONG_EFFORTS)
    await openPanel()
    expect(document.querySelector('[data-testid="composer-effort-reset"]')).toBeNull()
  })

  it.each([undefined, 'missing'])('没有合法默认项时不显示复位钮(default=%s)', async (defaultId) => {
    renderComposer('platform:glm-5.2', { selected: 'low', default: defaultId })
    await openPanel()
    expect(effortReadout()).toBe('低')
    expect(document.querySelector('[data-testid="composer-effort-reset"]')).toBeNull()
    expect(onEffortChange).not.toHaveBeenCalled()
  })

  it('搜索按名字过滤(照上游:清单一长就得找得到)', async () => {
    await openPanel()
    expect(visibleOptions().length).toBe(5)

    await page.getByTestId('composer-model-search').fill('glm')

    await until('search narrows to GLM 5.2', () => sameList(visibleOptions(), ['GLM 5.2']))
    expect(visibleOptions()).toEqual(['GLM 5.2'])
  })

  it('搜索认一级也认二级 —— 打「智谱」筛厂商,打 Gugu 筛来源', async () => {
    await openPanel()

    await page.getByTestId('composer-model-search').fill('智谱')
    // 上游把厂商名放在 `keywords` 里参与匹配;本仓没有那个字段,由二级的 providerLabel 承担。
    await until('search narrows to GLM 5.2', () => sameList(visibleOptions(), ['GLM 5.2']))
    expect(visibleOptions()).toEqual(['GLM 5.2'])

    await page.getByTestId('composer-model-search').fill('Gugu')
    // 一级组头同样进匹配面。⚠️ 打的是 `Gugu` 不是「咕咕」:平台那一级组头 #5082 之后走词表,
    // 而语言由本文件 beforeEach 钉成 en-US(**钉死,不是假定** —— 见那里的说明)。
    // 这条断言因此同时钉住「组头确实进了匹配面」和「它确实被翻译了」。
    await until('search narrows to the Gugu group', () => sameList(visibleOptions(), ['GLM 5.2', 'GPT-5.6 Sol']))
    expect(visibleOptions()).toEqual(['GLM 5.2', 'GPT-5.6 Sol'])
  })

  it('一级是「谁的」,厂商不分组 —— 厂商只在药丸和行内 logo 上', async () => {
    await openPanel()

    // owner 2026-09-06:「你的和咕咕的这个分类是一级分类,二标签是筛选」「你这个分类层次反了」。
    // ⇒ 组头只有两段(两档),即使里面混着 OpenAI 与智谱两家。
    // ⚠️ 这条同时是**回归守卫**:我第一版把厂商当组头,那时这里会读出三段。
    expect(visibleGroups()).toEqual([
      '你的 Codex 模型',
      'Models provided by Gugu · billed in credits'
    ])
    // 组头里既然没有厂商,行内那枚 logo 就是认厂商的唯一线索。
    // 图标**位**每行都有(5 行),真图标只有认得出厂商的那 4 行 —— 认不出的那条留白,不占位地收掉。
    const slots = document.querySelectorAll(
      '[data-slot="combobox-content"] [data-slot="composer-model-icon"]'
    )
    expect(slots.length).toBe(5)
    expect([...slots].filter((el) => el.childElementCount > 0).length).toBe(4)
    // 药丸才是厂商那根轴(二级 = 筛选)。
    // ⚠️ 按 testid 前缀取,不按 `[role="button"]`:Base UI 的 Toggle 渲染的是原生 `<button>`,
    // role 是**隐式**的,属性选择器一个都抓不到(实测读出空数组)。
    expect(
      [...document.querySelectorAll('[data-testid^="composer-model-provider-"]')].map((el) =>
        el.textContent?.trim()
      )
    ).toEqual(['OpenAI', '智谱'])
  })

  it('认不出厂商的那一行,名字仍与其它行左对齐', async () => {
    await openPanel()

    // 2026-09-06 实机取证撞出来的:claude 目录首项「Default (recommended)」认不出厂商,
    // 而当时的实现是「没图标就不画那一格」⇒ 它的名字在 x=992,其余 18 行在 x=1014,
    // **整整左移 22px,而且它是列表第一条**。缺一枚 logo 只是信息少一点,整行错位看着就是坏了。
    const lefts = [
      ...document.querySelectorAll(
        '[data-slot="combobox-content"] [data-slot="composer-model-name"]'
      )
    ].map((el) => Math.round(el.getBoundingClientRect().left))
    expect(lefts.length).toBe(5)
    expect(new Set(lefts).size, `各行名字左边缘: ${lefts.join(', ')}`).toBe(1)
  })

  it('厂商药丸:不选=不过滤,选一家只剩那一家(两档一起留下)', async () => {
    await openPanel()

    // 阳性对照:静息态五条都在 —— 否则下面「筛掉了」平凡为真。
    expect(visibleOptions().length).toBe(5)

    // 取证图:这是**唯一**带完整产品形状 fixture 的用例(两级分类 + 厂商 logo + 六档 Thinking),
    // 所以组头、药丸、图标只有在这里才拍得到。
    // composer-surface 那四张拍不出它们(那边的 fixture 没有分组,一家时药丸按设计不渲染)。
    // ⚠️ 先等弹层的入场动画走完再拍:点开就拍会拍到半透明的中间帧,那张图会让人以为
    //    面板本身是灰的(第一版正是这么拍出一张"看着像坏了"的图)。
    // 等的是「入场动画已播完」这件事:弹层带 data-open 时挂一段 `both` 填充的入场动画
    // (packages/session-ui/src/styles/recipes/popup-surface.css.ts 的 `&[data-open]` 那几条),
    // 播完后它仍在 getAnimations() 里、playState 为 finished。❌ 按固定毫秒等。
    await until('panel entry animation finished', () => {
      const popup = document.querySelector<HTMLElement>('[data-slot="combobox-content"][data-open]')
      return popup != null && popup.getAnimations().every((a) => a.playState === 'finished')
    })
    await page.screenshot({ path: 'composer-model-panel-providers.png' })

    await page.getByTestId('composer-model-provider-OpenAI').click()
    // 筛的是**厂商**,而厂商横切在两档之上 ⇒ 两档里的 OpenAI 条目都留下,两个组头也都还在。
    // 三条:你自己的 codex 与 Sol,加上咕咕代付的那条 Sol —— 同名不同档,两条都得在。
    await until('provider pill filters to OpenAI', () =>
      sameList(visibleOptions(), ['gpt-5.6-codex', 'GPT-5.6 Sol', 'GPT-5.6 Sol'])
    )
    expect(visibleOptions()).toEqual(['gpt-5.6-codex', 'GPT-5.6 Sol', 'GPT-5.6 Sol'])
    expect(visibleGroups()).toEqual([
      '你的 Codex 模型',
      'Models provided by Gugu · billed in credits'
    ])

    // 再点一次取消 ⇒ 回到「一个都没选」= 不过滤(上游原话:An empty filter means no filtering)。
    await page.getByTestId('composer-model-provider-OpenAI').click()
    await until('clearing the pill restores all five', () => visibleOptions().length === 5)
  })
})
