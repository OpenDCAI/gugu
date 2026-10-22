/**
 * #5818 侧栏会话行:行尾的置顶 / 归档**只认指针与真焦点** —— 真 Chromium、真 CSS、真组件。
 * 下半部分是 #6092 的身份卡:指针停在行上弹出这条会话是谁,取代了 #5818 那次标题翻转;#7334 起卡上只有
 * 任务名 / agent 名,点一行复制「标签：值」,会话 ID 挪到右键「复制会话 ID」。
 *
 * 守的是一次回归:#5643 为了修「看不见却能 Enter 触发归档」(#5642),把「这一行是键盘光标」
 * 也加进了显形判据;而点一行就会把键盘光标同步过去(`syncCursorFromPointer`),于是**选中的那一行
 * 从此常驻两枚钮**,还压住标题尾巴(owner 实机截图)。所以这条测试必须同时钉住两端:
 *
 *   ① 选中 + 键盘光标 + 行本身得焦(= 鼠标点一下之后的真实状态)→ 两枚钮仍是 0,时间仍是 1。
 *      少了「时间仍是 1」这半句,一个把两层一起藏掉的实现也能过 —— 而那正是原代码的第二个洞
 *      (`group-focus-within/row` 挂在行上,点一下行就把时间藏了)。
 *   ② 指针落到这一行 → 两枚钮 1、时间 0。
 *   ③ 键盘 Tab 到「归档」→ 它现形。这是 #5642 的判据,❌ 不许为了 ① 把它弄丢。
 *
 * **为什么必须真浏览器**:要判的是 `opacity-0` 与那几条 group 变体最终算出什么。Tailwind v4 对扫不到的
 * 类**静默丢掉整条 utility**,所以「类名写在 DOM 上」「typecheck 过了」都证明不了它真的生效 ——
 * `group-focus-within/row-actions` 这种带名字的变体尤其要实测。`:hover` 也不是能 dispatch 出来的
 * 事件状态,由引擎按指针位置判定,所以这里量到的 1 是引擎自己算的。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'

// 这一行真正要判的是 CSS,所以把它周围的宿主依赖换成同形的替身:store 树、导航、归档链路都会在
// import 期拉起整个应用状态(要 IPC),与本条无关。❌ 别连组件一起替 —— 那就变成在测一份抄件。
// ⚠️ 工厂里不能引用文件顶层的变量(vi.mock 被提升到最前,那些变量此刻还在 TDZ 里)—— 所以就地写。
vi.mock('@renderer/features/sessions/stores/session-registry', () => ({
  sessionRegistry: {
    get: () => ({
      sessions: {
        get: () => ({
          data: {
            providerId: 'claude',
            title: '我们目前的软件更新蛮奇怪的,谈了很多更新提示',
            isPinned: false,
            lastInteractedAt: new Date(Date.now() - 22 * 60_000).toISOString(),
          },
          status: 'idle',
        }),
      },
    }),
  },
}))
/**
 * 键盘光标那套是**真的**(session-keyboard-nav 没被替),它只从这一格取世界:
 *  · `navChain` 要包含这一行 —— 显式光标只在它还在链上时才作数(见 `get cursor`);
 *  · `navigation` 要说得出「主区在哪」,否则 `viewNode` 取不到值。
 * 项目树给空的:行按「项目没挂载」渲,与真实的早期状态同形。
 */
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {
    projects: { projects: new Map() },
    navigation: {
      currentViewId: 'session',
      viewParamsStore: { session: { projectId: 'proj-1', sessionId: 'task-1' } },
    },
  },
  sidebarStore: {
    searchQuery: '',
    setSearchQuery: () => {},
    navChain: [{ kind: 'conversation', projectId: 'proj-1', sessionId: 'conv-1' }],
    // 设置 `interface.showLeftSidebarAgentNameOnHover` 的镜像(现在开的是身份卡,#6092)。这里是**开**的那一档;
    // 关掉那一档由下面单独一条用例把它翻过去判。
    agentNameOnHoverEnabled: true,
    // #7199 行上「助理发起」的标记问 store;这里的会话都不是个人助理派的。
    launchedByAssistant: () => false,
  },
}))
vi.mock('@renderer/features/extensions/installed-extensions-store', () => ({
  installedExtensionsStore: { isLoaded: true, manifestFor: () => undefined, appName: () => undefined },
  // 资源库「扩展」那一格按机器各起一份清单(extensions-host.ts),侧栏经 use-agents 间接带上它。
  InstalledExtensionsStore: class {},
}))
vi.mock('@renderer/features/sessions/archive-session-flow', () => ({
  requestArchiveSession: vi.fn(),
  archiveSessionNow: vi.fn(),
  confirmArchive: () => undefined,
}))
vi.mock('@renderer/features/sessions/open-session-in-session', () => ({
  openSessionInSessionWhenReady: () => undefined,
}))
vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: () => {} }),
  useParams: () => ({ params: {} }),
  useWorkspaceSlots: () => ({ currentView: 'task' }),
}))

import { requestArchiveSession } from '@renderer/features/sessions/archive-session-flow'
import { sessionAgentNames } from '@renderer/features/sessions/stores/session-agent-names'
import { SidebarSessionItem } from '@renderer/features/sidebar/sidebar-session-item'
import { sidebarIdentityCard } from '@renderer/features/sidebar/sidebar-identity-card'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import '@/styles/tokens.css'
import '@renderer/index.css'

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  host = document.createElement('div')
  // 主题变量挂在 emlight/emdark 上;少了它 row-mask 那层底色算不出来。宽度取侧栏常规宽。
  host.className = 'gugu-skin emlight'
  host.style.width = '260px'
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  // 用例在假时钟下断言失败时,别把假时钟留给下一条。
  vi.useRealTimers()
  root.unmount()
  host.remove()
  // store 是模块单例:上一条 note 进去的身份会跨用例留着,而「没有身份」正是另一条要判的状态。
  sessionAgentNames.identities.clear()
  sidebarIdentityCard.close(sidebarIdentityCard.activeSessionId ?? '')
})

function mount(): void {
  root.render(
    <QueryClientProvider client={new QueryClient()}>
      <SessionLocalizationProvider>
        <SidebarSessionItem projectId="proj-1" sessionId="conv-1" />
      </SessionLocalizationProvider>
    </QueryClientProvider>
  )
}

const opacityOf = (el: HTMLElement): number => Number.parseFloat(getComputedStyle(el).opacity)

/** 行尾那两层:绝对定位的动作层(置顶/归档)与它底下占位的时间层。 */
function layers(): { actions: HTMLElement; rest: HTMLElement; row: HTMLElement } {
  const slot = host.querySelector<HTMLElement>('[data-row-hover-actions]')
  expect(slot, '行尾那一格该渲出来 —— 没有它,下面的读数就是在量空气').not.toBeNull()
  const children = Array.from(slot!.children) as HTMLElement[]
  expect(children).toHaveLength(2)
  return {
    actions: children[0],
    rest: children[1],
    row: host.querySelector<HTMLElement>('[data-session-id="conv-1"]')!,
  }
}

/** 等过渡落定再量 —— 这一层走 --dur-fast 那一档,量在半路会读到中间值。等的是「落到目标值」这件事,不给时限(#4357)。 */
async function settled(el: HTMLElement, expected: number): Promise<void> {
  await until(`opacity settles at ${expected}`, () => Math.abs(opacityOf(el) - expected) < 0.005)
}

/** 行挂载好了:行尾那一格出现。 */
async function mounted(): Promise<void> {
  await until('sidebar row mounted', () => host.querySelectorAll('[data-row-hover-actions]').length === 1)
}

const identityCard = () => document.querySelector<HTMLElement>('[data-sidebar-identity-card]')

/**
 * 开卡要停够一段时长、离开要过一段宽限 —— 那是产品的延时策略,判它就把时间当输入:假时钟下
 * 「还没推时间 ⇒ 没开」「把排着的那一次推过去 ⇒ 开了」都是确定的事实,❌ 真睡一段墙钟再看(#4357)。
 * 只假 setTimeout / clearTimeout;等 DOM 之前切回真时钟,免得组件内部别的定时器被一起冻住。
 */
function fakeTimers(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
}

/** 指针真的落在这一行上了(pointerenter 与 :hover 同一次指针移动)。 */
async function hovered(row: HTMLElement): Promise<void> {
  await userEvent.hover(row)
  await until('pointer is over the row', () => row.matches(':hover'))
}

/** 一块谁也不挡的角落,用来把真指针挪出侧栏(它跨用例留在原地)。 */
function park(): HTMLElement {
  const el = document.createElement('div')
  el.style.cssText = 'position:fixed;right:0;bottom:0;width:120px;height:120px'
  document.body.append(el)
  return el
}

/** 产品里最常见的那一格:刚点开这一行(键盘光标随之落到这儿、行也拿着焦点),然后指针离开。 */
async function clickThenPark(row: HTMLElement): Promise<void> {
  await userEvent.click(row)
  await until('the clicked row becomes the keyboard cursor', () => row.dataset.navCursor === 'true')
  await userEvent.hover(park())
}

it('#5818 点开这一行再把指针挪走,置顶/归档不留,时间照画', async () => {
  mount()
  await mounted()

  const { actions, rest, row } = layers()

  // 阳性对照:两层都得真的在排版里占着位置,否则「opacity 为 0」与「根本没渲出来」同形。
  expect(actions.getBoundingClientRect().width).toBeGreaterThan(0)
  expect(rest.getBoundingClientRect().width).toBeGreaterThan(0)

  // owner 的原始复现:真的点一下这一行,再把指针挪走。
  // ❌ 不摆一个假的 cursor —— 「点一下就成了键盘光标」(syncCursorFromPointer)正是这条 bug 的成因,
  // 摆假的等于把要判的那一环替掉了。
  await clickThenPark(row)

  await settled(actions, 0)
  await settled(rest, 1)
})

it('#5818 指针落到这一行,两枚钮淡入、时间让位', async () => {
  mount()
  await mounted()
  const { actions, rest, row } = layers()

  // 每条都从「刚被点开的那一行」起头(键盘光标就在这儿、行也拿着焦点)——
  // 这是产品里最常见的那一格,也保证这几条彼此不靠执行顺序传递状态。
  await clickThenPark(row)
  await settled(actions, 0)
  const restRect = rest.getBoundingClientRect()

  await userEvent.hover(row)
  await settled(actions, 1)
  await settled(rest, 0)

  // 隐去用的是 opacity 不是卸载:时间那一格照旧占位,指针进出时标题的截断宽度不抖。
  const afterRect = rest.getBoundingClientRect()
  expect(afterRect.left).toBeCloseTo(restRect.left, 1)
  expect(afterRect.width).toBeCloseTo(restRect.width, 1)
})

it('#5642 键盘 Tab 到归档,它当场现形(不许为了 #5818 把这条弄丢)', async () => {
  mount()
  await mounted()
  const { actions, row } = layers()
  await clickThenPark(row)
  await settled(actions, 0)

  const archive = Array.from(actions.querySelectorAll('button')).at(-1)
  expect(archive, '行尾该有置顶与归档两枚钮').toBeDefined()

  // 真键盘:焦点落到文档头,一路 Tab 走到归档。`:focus-within` 认的是「容器里有焦点」,
  // 而这一条要证明的正是它算得出来 —— Tailwind 对生成不出来的带名变体是静默丢掉整条 utility 的。
  await userEvent.click(document.body)
  for (let i = 0; i < 8 && document.activeElement !== archive; i += 1) {
    await userEvent.keyboard('{Tab}')
  }
  await until('Tab reaches the archive button', () => document.activeElement === archive)
  await settled(actions, 1)
})

it('行尾的归档:按下后指针挪了几个像素再松开,仍是一次点击,不会变成拖走这一行', async () => {
  vi.mocked(requestArchiveSession).mockClear()
  mount()
  await mounted()
  const { actions, row } = layers()
  const title = row.querySelector<HTMLElement>(`button[aria-label^="${translateSessionMessage('sidebar.openConversation', { title: '' }).trim()}"]`)!
  const archive = Array.from(actions.querySelectorAll('button')).at(-1)!
  const dragSources: EventTarget[] = []
  const onDragStart = (e: DragEvent) => dragSources.push(e.target!)
  document.addEventListener('dragstart', onDragStart)
  try {
    // 同一个手势:按下、横挪 12px(过了 Chromium 4px 的拖拽阈值)、松开 —— 手抖一下的那种点击。
    const jitter = { sourcePosition: { x: 6, y: 12 }, targetPosition: { x: 18, y: 12 } }

    // 阳性对照:落在标题上,这个手势就是拖这一行。没有它,「没发 dragstart」也可能只是手势没过阈值。
    await userEvent.dragAndDrop(title, title, jitter)
    expect(dragSources).toEqual([row])
    dragSources.length = 0

    await hovered(row)
    await settled(actions, 1)
    await userEvent.dragAndDrop(archive, archive, jitter)
    expect(dragSources).toEqual([])
    expect(requestArchiveSession).toHaveBeenCalledTimes(1)
  } finally {
    document.removeEventListener('dragstart', onDragStart)
  }
})

const AGENT_USER_ID = 'agent-user-id-0123456789abcdef'
const TITLE = '我们目前的软件更新蛮奇怪的,谈了很多更新提示'

/** 换掉剪贴板,记下写进去的每一段。 */
function stubClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  return writeText
}

/**
 * 复制出去的那一段。测试进程的语言随机器走,两种文案都算;要判的是「标签：值」这个形状、
 * 标签是哪一行的、值是什么 —— 中文「任务名：X」「Agent 名：Y」,英文「Task: X」「Agent: Y」。
 */
function pairOf(text: string): [string, string] {
  const m = /^(任务名|Agent 名)：(.*)$/.exec(text) ?? /^(Task|Agent): (.*)$/.exec(text)
  expect(m, `复制出去的不是「标签：值」的形状:${JSON.stringify(text)}`).not.toBeNull()
  return [/^(任务名|Task)$/.test(m![1]) ? 'session' : 'agent', m![2]]
}

/** 停够开卡的时长,等卡渲出来。 */
async function openCard(row: HTMLElement): Promise<HTMLElement> {
  fakeTimers()
  await hovered(row)
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  await until('identity card renders', () => identityCard() !== null)
  return identityCard()!
}

it('#7334 指针停在行上,右侧弹出身份卡:只有任务名 / agent 名两行,不摆两枚 ID;卡上没有多余的线', async () => {
  // 卡开在行右侧要有地方放:默认视口太窄时定位系统会翻到左边再贴边,那量到的就不是「右侧」这一格了。
  await page.viewport(1024, 768)
  sessionAgentNames.note('conv-1', 'Claude 3', AGENT_USER_ID)
  const clipboard = stubClipboard()
  mount()
  await mounted()
  const row = host.querySelector<HTMLElement>('[data-session-id="conv-1"]')!

  // 静止:没有卡。阴性对照 —— 卡不是渲出来再藏,是压根不在 DOM 里。
  await clickThenPark(row)
  expect(identityCard()).toBeNull()

  // 指针停上来:要停够开卡的时长,扫过去不该闪。时间是输入:没推时间就没开;把那次开卡的倒计时推过去才开。
  fakeTimers()
  await hovered(row)
  expect(sidebarIdentityCard.activeSessionId, '指针刚落上来、时长还没到:不该开').toBeNull()
  vi.runOnlyPendingTimers()
  expect(sidebarIdentityCard.activeSessionId).toBe('conv-1')
  vi.useRealTimers()
  await until('identity card renders', () => identityCard() !== null)
  const card = identityCard()!

  const keys = Array.from(card.querySelectorAll<HTMLElement>('[data-identity-row]')).map((el) => el.dataset.identityRow)
  expect(keys).toEqual(['sessionName', 'agentName'])
  expect(card.querySelector('[data-identity-row="sessionName"]')!.textContent).toContain('软件更新')
  expect(card.querySelector('[data-identity-row="agentName"]')!.textContent).toContain('Claude 3')
  // 两枚 ID 不在卡上 —— 连前缀也没有。阳性对照:同一张卡的文字里确实读得到 agent 名(上一句),读法没坏。
  expect(card.textContent).not.toContain(AGENT_USER_ID.slice(0, 8))
  expect(card.textContent).not.toContain('conv-1')
  expect(card.textContent).not.toMatch(/Session ID|Agent ID/)
  // 不挂原生 title:一个飘在别处的浏览器 tooltip 只会打断排版(owner 2026-09-21)。
  for (const el of card.querySelectorAll<HTMLElement>('[title]')) expect(el.title).toBe('')

  // 卡在行右边,不盖住行;命中区(Popup 连同朝行那侧的透明边)与行贴住,中间没有「两边都不是」的缝。
  // 入场是 zoom-in,量在半路会读到缩放中的框 —— 等动画落定。
  await until('card entry animation settles', () => card.getAnimations().length === 0)
  const rowRect = row.getBoundingClientRect()
  const visibleCard = card.firstElementChild as HTMLElement
  expect(visibleCard.getBoundingClientRect().left).toBeGreaterThanOrEqual(rowRect.right)
  expect(Math.abs(card.getBoundingClientRect().left - rowRect.right)).toBeLessThanOrEqual(1)

  // 行之间没有分隔线(design.md 线预算):两行都不带 border-top/bottom。
  for (const el of card.querySelectorAll<HTMLElement>('[data-identity-row]')) {
    const cs = getComputedStyle(el)
    expect(cs.borderTopWidth).toBe('0px')
    expect(cs.borderBottomWidth).toBe('0px')
  }

  // 两行各是一枚复制按钮,各复制各的(owner 2026-10-16:「复制任务名就是复制任务名」)。
  const sessionRow = card.querySelector<HTMLElement>('[data-identity-row="sessionName"]')!
  const agentRow = card.querySelector<HTMLElement>('[data-identity-row="agentName"]')!
  expect(sessionRow.tagName).toBe('BUTTON')
  expect(agentRow.tagName).toBe('BUTTON')

  // 点一行只复制这一行,带上它的标签;复制不关卡、不打开会话(click 被拦在行内)。
  await userEvent.click(agentRow)
  expect(clipboard).toHaveBeenCalledTimes(1)
  expect(pairOf(clipboard.mock.calls[0][0])).toEqual(['agent', 'Claude 3'])
  await until('the copied row says so', () => agentRow.dataset.copyState === 'copied')
  expect(sessionRow.dataset.copyState, '只有被点的那一行说「已复制」').toBe('idle')
  expect(identityCard()).not.toBeNull()
  await userEvent.click(sessionRow)
  expect(pairOf(clipboard.mock.calls[1][0])).toEqual(['session', TITLE])

  // 收卡不等(owner 2026-10-08:「应该是立即消失,而不是过一会儿才消失」)。时钟冻着:收不靠任何定时器到点,
  // 离开的那一下就收 —— 一个「宽限 0ms」的定时器在这里也会读成还开着。
  // ① 从卡里离开 ⇒ 当场收。(上面那次点复制,指针就是从行直接走进卡的,卡一直开着。)
  expect(card.matches(':hover'), '指针此刻在卡上').toBe(true)
  fakeTimers()
  await userEvent.hover(park())
  expect(sidebarIdentityCard.activeSessionId, '离开卡:当场收').toBeNull()
  vi.useRealTimers()
  await until('identity card is gone', () => identityCard() === null)

  // ② 离开行、没进卡 ⇒ 当场收。
  fakeTimers()
  await hovered(row)
  vi.runOnlyPendingTimers()
  expect(sidebarIdentityCard.activeSessionId).toBe('conv-1')
  await userEvent.hover(park())
  expect(sidebarIdentityCard.activeSessionId, '离开行、没进卡:当场收').toBeNull()
  vi.useRealTimers()
  await until('identity card is gone', () => identityCard() === null)
})

it('#6092 花名册里没有这条会话时,agent 那一行写「未分配」且不可复制;任务名那一行照常复制', async () => {
  const clipboard = stubClipboard()
  mount()
  await mounted()
  const row = host.querySelector<HTMLElement>('[data-session-id="conv-1"]')!
  await clickThenPark(row)
  const card = await openCard(row)
  // 测试进程的语言随机器走,两种文案都算;要判的是「不是标题」。
  expect(card.querySelector('[data-identity-row="agentName"]')!.textContent).toMatch(/未分配|Not assigned/)
  // ❌ 不拿标题冒充人名。
  expect(card.querySelector('[data-identity-row="agentName"]')!.textContent).not.toContain('软件更新')

  // ❌ 把「未分配」当成一个值粘出去:那一行不是按钮。
  expect(card.querySelector('[data-identity-row="agentName"]')!.tagName).not.toBe('BUTTON')
  await userEvent.click(card.querySelector<HTMLElement>('[data-identity-row="sessionName"]')!)
  expect(clipboard).toHaveBeenCalledTimes(1)
  expect(pairOf(clipboard.mock.calls[0][0])).toEqual(['session', TITLE])
})

it('#7334 右键「复制会话 ID」:复制完整的会话 ID', async () => {
  sessionAgentNames.note('conv-1', 'Claude 3', AGENT_USER_ID)
  const clipboard = stubClipboard()
  mount()
  await mounted()
  const row = host.querySelector<HTMLElement>('[data-session-id="conv-1"]')!
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
  await until('context menu items render', () => document.querySelectorAll('[data-slot="context-menu-item"]').length > 0)
  const items = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="context-menu-item"]'))
  const item = items.find((el) => /复制会话 ID|Copy session ID/.test(el.textContent ?? ''))
  expect(item, `菜单里该有「复制会话 ID」这一格,实际:${items.map((i) => i.textContent).join(' | ')}`).toBeDefined()
  await userEvent.click(item!)
  await until('session id copied', () => clipboard.mock.calls.length > 0)
  expect(clipboard).toHaveBeenCalledWith('conv-1')
})

it('#6092 设置里关掉之后,悬浮不再弹卡 —— 开关是真的接着这一行的', async () => {
  const { sidebarStore } = await import('@renderer/lib/stores/app-state')
  sessionAgentNames.note('conv-1', 'Claude 3', AGENT_USER_ID)
  const store = sidebarStore as { agentNameOnHoverEnabled: boolean }
  store.agentNameOnHoverEnabled = false
  try {
    mount()
    await mounted()
    const row = host.querySelector<HTMLElement>('[data-session-id="conv-1"]')!
    // 阴性:把排着的定时器全推过去(开着时这一步就会开卡 —— 见上面 #6092 那条的阳性),仍然没有卡。
    fakeTimers()
    await hovered(row)
    vi.runOnlyPendingTimers()
    expect(sidebarIdentityCard.activeSessionId).toBeNull()
    vi.useRealTimers()
    expect(identityCard()).toBeNull()
    expect(row.innerText).toContain('软件更新')
  } finally {
    store.agentNameOnHoverEnabled = true
  }
})

it('点击不是悬浮:进行就点、停够了再点,点完都没有卡;离开再回来才重新弹', async () => {
  sessionAgentNames.note('conv-1', 'Claude 3', AGENT_USER_ID)
  mount()
  await mounted()
  const row = host.querySelector<HTMLElement>('[data-session-id="conv-1"]')!
  await userEvent.hover(park())

  // ① 指针进来立刻点(开卡倒计时还没到点)—— 原来卡会在点完之后自己弹出来。
  //    时间是输入:点完把排着的定时器全推过去,仍然没开。
  fakeTimers()
  await userEvent.click(row)
  await until('pointer is over the row', () => row.matches(':hover'))
  vi.runOnlyPendingTimers()
  expect(sidebarIdentityCard.activeSessionId, '进来就点:点完不该冒出卡').toBeNull()
  vi.useRealTimers()
  expect(identityCard()).toBeNull()

  // ② 离开再回来、停够了卡开着,再点 —— 卡当场收,指针不离开就不再开。
  await userEvent.hover(park())
  fakeTimers()
  await hovered(row)
  vi.runOnlyPendingTimers()
  expect(sidebarIdentityCard.activeSessionId).toBe('conv-1')
  vi.useRealTimers()
  await until('identity card renders', () => identityCard() !== null)
  fakeTimers()
  await userEvent.click(row)
  expect(sidebarIdentityCard.activeSessionId, '停够再点:卡当场收').toBeNull()
  vi.runOnlyPendingTimers()
  expect(sidebarIdentityCard.activeSessionId, '停够再点:点完卡不该重开').toBeNull()
  vi.useRealTimers()
  await until('identity card is gone', () => identityCard() === null)

  // ③ 阳性对照:离开再回来,悬浮照常弹 —— 点过的抑制只管到离开为止。
  await userEvent.hover(park())
  fakeTimers()
  await hovered(row)
  vi.runOnlyPendingTimers()
  expect(sidebarIdentityCard.activeSessionId).toBe('conv-1')
  vi.useRealTimers()
  await until('identity card renders', () => identityCard() !== null)
})
