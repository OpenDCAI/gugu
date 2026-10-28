import { createChatContext } from '@session-chat/chat-context'
import { createChatView } from '@session-chat/chat-view'
import type { ChatCommands } from '@session-chat/commands'
import { DEFAULT_THEME } from '@session-chat/core/theme'
import type { BackgroundCommandEntry } from '@session-chat/lib/background-command-roster'
import { placeSubagentPanel } from '@session-chat/components/rows/background-tasks/background-tasks-parts'
import type { SubagentRosterEntry } from '@session-chat/lib/subagent-roster'
import type { TranscriptTurn } from '@session-chat/model'
import { createChatState } from '@session-chat/state/chat-state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { until } from '../../../../tests/support/awaitCondition'

/**
 * 还在跑的后台命令与子智能体,贴在消息列表最后一行(owner 2026-10-27:去掉右上角「摘要」卡,后台任务放进主对话)。
 *
 * 钉的是:轮早就收口了它照样在(后台命令不挂住这一轮);收着是一句话,点开就地展开成单子;停止报给供应商的那个 id、
 * × 只收起;一条都不剩这一行就没了。
 */
const teardown: Array<() => void> = []

afterEach(() => {
  while (teardown.length) teardown.pop()?.()
})

function mount(commands: ChatCommands = {}, conversation = false) {
  const context = createChatContext({ theme: DEFAULT_THEME })
  if (conversation) context.setLayout({ preset: 'double', userGutter: 72, agentConversation: true })
  const state = createChatState(context)
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;inset:0;width:640px;height:600px'
  document.body.append(host)
  const view = createChatView({ context, state, parent: host, commands })
  teardown.push(() => {
    view.dispose()
    state.dispose()
    context.dispose()
    host.remove()
  })
  return { state, host }
}

const settled: TranscriptTurn = {
  id: 't1',
  seq: 0,
  initiator: 'user',
  startedAt: Date.now() - 60_000,
  items: [
    { kind: 'message', id: 'q', seq: 0, role: 'user', text: 'Run the tests in the background.' },
    { kind: 'message', id: 'a', seq: 1, role: 'assistant', text: 'Started them; I will report back.' }
  ]
}

const command: BackgroundCommandEntry = {
  id: 'cmd-item',
  launchToolCallId: 'toolu_cmd',
  taskId: 'task-42',
  name: 'pnpm test'
}

const agent = (over: Partial<SubagentRosterEntry> = {}): SubagentRosterEntry => ({
  id: 'agent-item',
  launchToolCallId: 'toolu_agent',
  name: 'Audit chat perf',
  completedSteps: 3,
  calls: [],
  elapsedMs: 0,
  startedAt: Date.now() - 30_000,
  canCancel: true,
  ...over
})

const row = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-slot="background-tasks"]')
const items = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[data-slot="background-task"]')]

describe('background tasks at the end of the transcript', () => {
  it('stays after the turn settled, folded into one line until opened', async () => {
    const { state, host } = mount()
    state.transcript.history.seed([settled])
    state.session.setBackgroundTasks({ commands: [command], subagents: [agent()] })

    await until('the background line is on screen', () => row(host) !== null)
    expect(row(host)?.textContent).toContain('Background · 1 command · 1 subagent')
    // 收着:只有那一句,单子不画。
    expect(items(host)).toHaveLength(0)

    host.querySelector<HTMLElement>('[data-collapse-id="background-tasks:open"]')?.click()
    await until('the list opens in place', () => items(host).length === 2)
    const [cmdRow, agentRow] = items(host)
    expect(cmdRow.dataset.taskKind).toBe('command')
    expect(cmdRow.textContent).toContain('pnpm test')
    expect(agentRow.textContent).toContain('Audit chat perf')
    expect(agentRow.textContent).toContain('3 steps')
    expect(agentRow.textContent).toMatch(/3\ds/)

    // 它是最后一行:回复在它上面。
    const reply = [...host.querySelectorAll('*')].find((el) => el.textContent === 'Started them; I will report back.')
    expect(reply).toBeTruthy()
    expect(reply!.getBoundingClientRect().top).toBeLessThan(row(host)!.getBoundingClientRect().top)

    // 再点一下收回去。
    host.querySelector<HTMLElement>('[data-collapse-id="background-tasks:open"]')?.click()
    await until('the list folds back', () => items(host).length === 0)
  })

  it('stop reports the provider id, × only dismisses, and a subagent that cannot be cancelled has no stop', async () => {
    const onStopBackgroundTask = vi.fn()
    const onDismissBackgroundTask = vi.fn()
    const { state, host } = mount({ onStopBackgroundTask, onDismissBackgroundTask })
    state.transcript.history.seed([settled])
    state.session.setBackgroundTasks({
      commands: [command],
      subagents: [agent(), agent({ id: 'fg-item', launchToolCallId: 'toolu_fg', name: 'Foreground', canCancel: false })]
    })
    await until('the background line is on screen', () => row(host) !== null)
    host.querySelector<HTMLElement>('[data-collapse-id="background-tasks:open"]')?.click()
    await until('the list opens', () => items(host).length === 3)

    const [cmdRow, agentRow, fgRow] = items(host)
    cmdRow.querySelector<HTMLElement>('button[aria-label="Stop this background command"]')?.click()
    // 后台命令停的是供应商给它的 asyncTaskId,❌ tool_use id(#5117)。
    expect(onStopBackgroundTask).toHaveBeenCalledWith({ stopId: 'task-42' })
    agentRow.querySelector<HTMLElement>('button[aria-label="Stop this subagent"]')?.click()
    expect(onStopBackgroundTask).toHaveBeenLastCalledWith({ stopId: 'toolu_agent' })
    expect(fgRow.querySelector('button[aria-label="Stop this subagent"]')).toBeNull()

    agentRow.querySelector<HTMLElement>('button[aria-label="Remove from list (does not stop it)"]')?.click()
    expect(onDismissBackgroundTask).toHaveBeenCalledWith({ entryId: 'agent-item' })
    // 按钮不是开关:列表照旧开着。
    expect(items(host)).toHaveLength(3)
  })

  it('has no buttons when the host wires none', async () => {
    const { state, host } = mount()
    state.transcript.history.seed([settled])
    state.session.setBackgroundTasks({ commands: [command], subagents: [] })
    await until('the background line is on screen', () => row(host) !== null)
    expect(row(host)?.textContent).toContain('Background · 1 command')
    expect(row(host)?.textContent).not.toContain('subagent')
    host.querySelector<HTMLElement>('[data-collapse-id="background-tasks:open"]')?.click()
    await until('the list opens', () => items(host).length === 1)
    expect(items(host)[0].querySelectorAll('button')).toHaveLength(0)
  })

  it('disappears once nothing is left running', async () => {
    const { state, host } = mount()
    state.transcript.history.seed([settled])
    state.session.setBackgroundTasks({ commands: [command], subagents: [] })
    await until('the background line is on screen', () => row(host) !== null)
    state.session.setBackgroundTasks({ commands: [], subagents: [] })
    await until('the background line is gone', () => row(host) === null)
  })

  it('shows on an empty transcript too (nothing else in the last tier)', async () => {
    const { state, host } = mount()
    state.session.setBackgroundTasks({ commands: [], subagents: [agent()] })
    await until('the background line is on screen', () => row(host) !== null)
    expect(row(host)?.textContent).toContain('Background · 1 subagent')
  })

  // owner 2026-10-27 原型:末尾那条回复带着过程行时,后台那一句与「思考执行中」同一行,单子就地展开在它下面。
  it('hangs on a live process line that has no reply yet, across the steps under it', async () => {
    const { state, host } = mount({}, true)
    state.transcript.activeTurn.set({
      id: 'live', seq: 0, initiator: 'user', startedAt: Date.now() - 5000,
      items: [
        { kind: 'message', id: 'q', seq: 0, role: 'user', text: 'Run four commands.' },
        { kind: 'tool', id: 't1', seq: 1, name: 'bash', status: 'done' },
        { kind: 'tool', id: 't2', seq: 2, name: 'bash', status: 'running' },
      ]
    } as unknown as TranscriptTurn)
    state.session.setBackgroundTasks({ commands: [command], subagents: [agent()] })
    // owner 0 号图:「思考执行中 · … · N 步 ⌄ | 后台 · … ›」同一行,❌ 单独一行排在步骤下面。
    const pill = () => host.querySelector<HTMLElement>('[data-slot="turn-process"] [data-slot="background-tasks-pill"]')
    await until('the background pill sits on the live process line', () => pill() !== null)
    expect(row(host)).toBeNull()
    const process = host.querySelector<HTMLElement>('[data-slot="turn-process"] [data-conversation-process]')!
    expect(Math.abs(process.getBoundingClientRect().top - pill()!.getBoundingClientRect().top)).toBeLessThanOrEqual(2)
    // 真机验收 10-28:没出正文时这一行 14px、左半边比药丸低 4px —— 要跟回复头里那一行同字号、同一条中线。
    expect(getComputedStyle(process).fontSize).toBe(getComputedStyle(pill()!).fontSize)
    const middle = (el: HTMLElement) => { const box = el.getBoundingClientRect(); return box.top + box.height / 2 }
    expect(Math.abs(middle(process) - middle(pill()!))).toBeLessThanOrEqual(1)
    pill()!.click()
    await until('the list opens in that row', () => items(host).length === 2)
    expect(host.querySelector('[data-slot="turn-process"]')!.contains(items(host)[0])).toBe(true)
    // owner 10-28:过程行和后台各管各的 —— 收起过程,后台单子照样开着、照样能点;开合后台,过程行不动。
    const line = () => host.querySelector<HTMLElement>('[data-slot="turn-process"]')!
    const processOpen = line().dataset.expanded
    host.querySelector<HTMLElement>('[data-slot="turn-process"] [data-conversation-process]')!.click()
    await until('the process line folds', () => line().dataset.expanded !== processOpen)
    expect(items(host)).toHaveLength(2)
    expect(pill()).not.toBeNull()
    pill()!.click()
    await until('the list closes on its own toggle', () => items(host).length === 0)
    expect(line().dataset.expanded).not.toBe(processOpen)
    pill()!.click()
    await until('and opens again with the process folded', () => items(host).length === 2)
  })

  it('hangs on the last reply\'s process line in the conversation layout, not as its own row', async () => {
    const { state, host } = mount({}, true)
    const worked: TranscriptTurn = {
      id: 'w1',
      seq: 0,
      initiator: 'user',
      startedAt: 1000,
      endedAt: 25000,
      outcome: { kind: 'done', reason: 'end_turn' },
      items: [
        { kind: 'message', id: 'q', seq: 0, role: 'user', text: 'Run the tests in the background.' },
        { kind: 'thinking', id: 'think', seq: 1, text: 'hmm' },
        { kind: 'message', id: 'answer', seq: 2, role: 'assistant', text: 'Started them; I will report back.' }
      ]
    } as unknown as TranscriptTurn
    state.transcript.history.seed([worked])
    state.session.setBackgroundTasks({ commands: [command], subagents: [agent()] })

    // 对话布局里一轮回复拆成「名字 + 过程行」那一行(answer:head)和气泡那一行(answer)。
    const pill = () => host.querySelector<HTMLElement>('[data-agent-conversation-message="answer:head"] [data-slot="background-tasks-pill"]')
    await until('the background line sits on the reply\'s process line', () => pill() !== null)
    expect(pill()?.textContent).toContain('Background · 1 command · 1 subagent')
    expect(row(host)).toBeNull()
    const process = host.querySelector<HTMLElement>('[data-agent-conversation-message="answer:head"] [data-conversation-process]')!
    // 同一行
    expect(Math.abs(process.getBoundingClientRect().top - pill()!.getBoundingClientRect().top)).toBeLessThanOrEqual(2)

    pill()!.click()
    await until('the list opens under that line, above the bubble', () => items(host).length === 2)
    const head = host.querySelector<HTMLElement>('[data-agent-conversation-message="answer:head"]')!
    expect(head.contains(items(host)[0])).toBe(true)
    const bubble = host.querySelector<HTMLElement>('[data-agent-conversation-message="answer"] [data-user-card]')!
    // 气泡是下一行:头那一行长高有个过渡,等它落定。
    await until('the bubble row settles below the open list', () => items(host)[1].getBoundingClientRect().bottom <= bubble.getBoundingClientRect().top)

    // 人接着说话:新的一轮开跑,它那条「执行中」过程行就是末尾 ⇒ 后台挂到这条新过程行上
    // (#703:在跑、还没出正文的过程行也挂后台),❌ 留在上一轮的回复上,也 ❌ 单独一行。
    state.transcript.activeTurn.set({
      id: 'w2', seq: 1, initiator: 'user', startedAt: Date.now(),
      items: [{ kind: 'message', id: 'q2', seq: 0, role: 'user', text: 'And lint too.' }]
    } as unknown as TranscriptTurn)
    const livePill = () => host.querySelector<HTMLElement>('[data-slot="turn-process"] [data-slot="background-tasks-pill"]')
    await until('the background line moves to the new live process line', () => livePill() !== null && pill() === null)
    expect(row(host)).toBeNull()
  })

  // owner 2026-10-27 拍板补回:悬停子智能体那一行,弹出它的工具时间线(样式照原来摘要卡里那张)。
  it('hovering a subagent row shows its tool timeline, and the panel survives roster updates', async () => {
    const { state, host } = mount()
    const calls = [
      { toolCallId: 'c1', title: 'Read src/ChatRoot.tsx', status: 'done' as const, seq: 0 },
      { toolCallId: 'c2', title: 'Grep "virtualizer"', status: 'error' as const, seq: 1 },
      { toolCallId: 'c3', title: 'Run pnpm test', status: 'running' as const, seq: 2 }
    ]
    state.transcript.history.seed([settled])
    state.session.setBackgroundTasks({ commands: [], subagents: [agent({ model: 'claude-sonnet', calls })] })
    await until('the background line is on screen', () => row(host) !== null)
    host.querySelector<HTMLElement>('[data-collapse-id="background-tasks:open"]')?.click()
    await until('the list opens', () => items(host).length === 1)

    const agentRow = items(host)[0]
    // 浮层写全了名字,❌ 再叠原生 title。
    expect(agentRow.title).toBe('')
    const panel = () => document.querySelector<HTMLElement>('[data-slot="subagent-hover-panel"]')
    agentRow.dispatchEvent(new MouseEvent('mouseenter'))
    expect(panel()).toBeNull()
    await until('the panel opens after the hover delay', () => panel() !== null)
    // 被行的 overflow 裁掉就看不见了:它 portal 在行外面。
    expect(agentRow.contains(panel())).toBe(false)
    expect(panel()!.textContent).toContain('Audit chat perf')
    expect(panel()!.textContent).toContain('claude-sonnet')
    const steps = [...panel()!.querySelectorAll<HTMLElement>('[data-slot="subagent-timeline-step"]')]
    expect(steps.map((s) => [s.dataset.status, s.textContent])).toEqual([
      ['done', 'Read src/ChatRoot.tsx'],
      ['error', 'Grep "virtualizer"'],
      ['running', 'Run pnpm test']
    ])

    // 名单来了更新(新对象):浮层还开着,多出来的那一步也画上。
    state.session.setBackgroundTasks({
      commands: [],
      subagents: [agent({ model: 'claude-sonnet', calls: [...calls, { toolCallId: 'c4', title: 'Edit a.ts', status: 'running', seq: 3 }] })]
    })
    await until('the new step shows', () => panel()?.querySelectorAll('[data-slot="subagent-timeline-step"]').length === 4)

    items(host)[0].dispatchEvent(new MouseEvent('mouseleave'))
    // 挪到浮层上它不关。
    panel()!.dispatchEvent(new MouseEvent('mouseenter'))
    await new Promise((r) => setTimeout(r, 250))
    expect(panel()).not.toBeNull()
    panel()!.dispatchEvent(new MouseEvent('mouseleave'))
    await until('the panel closes after leaving it', () => panel() === null)
  })

  it('says so when the subagent has no steps yet', async () => {
    const { state, host } = mount()
    state.transcript.history.seed([settled])
    state.session.setBackgroundTasks({ commands: [], subagents: [agent()] })
    await until('the background line is on screen', () => row(host) !== null)
    host.querySelector<HTMLElement>('[data-collapse-id="background-tasks:open"]')?.click()
    await until('the list opens', () => items(host).length === 1)
    items(host)[0].dispatchEvent(new MouseEvent('mouseenter'))
    const panel = () => document.querySelector<HTMLElement>('[data-slot="subagent-hover-panel"]')
    await until('the panel opens', () => panel() !== null)
    expect(panel()!.textContent).toContain('No steps yet')
    expect(panel()!.querySelector('[data-slot="subagent-timeline"]')).toBeNull()
  })

  it('places the panel beside the row when there is room, else under it right-aligned, flipping above near the bottom edge', () => {
    const panel = { width: 320, height: 200 }
    const wide = { width: 1600, height: 600 }
    // 宽窗口:贴在行右边、与行顶对齐。
    expect(placeSubagentPanel({ top: 100, bottom: 128, left: 360, right: 960 }, panel, wide)).toEqual({ top: 100, left: 966 })
    // 贴着窗口底:往上收进窗口。
    expect(placeSubagentPanel({ top: 560, bottom: 588, left: 360, right: 960 }, panel, wide).top).toBe(392)
    const narrow = { width: 1200, height: 600 }
    // 右边放不下:放到行下方,与行右对齐(左边那列名字留给鼠标往下挪)。
    expect(placeSubagentPanel({ top: 100, bottom: 128, left: 360, right: 960 }, panel, narrow)).toEqual({ top: 134, left: 640 })
    // 贴着窗口底:翻到行上方。
    expect(placeSubagentPanel({ top: 540, bottom: 568, left: 360, right: 960 }, panel, narrow)).toEqual({ top: 334, left: 640 })
    // 行很窄靠左:左边夹在窗口里。
    expect(placeSubagentPanel({ top: 100, bottom: 128, left: 0, right: 200 }, panel, { width: 400, height: 600 }).left).toBe(8)
    // 上下都放不下:贴着窗口底,❌ 出窗。
    expect(placeSubagentPanel({ top: 150, bottom: 178, left: 360, right: 960 }, { width: 320, height: 500 }, narrow).top).toBe(92)
  })
})
