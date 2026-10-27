import { createChatContext } from '@session-chat/chat-context'
import { createChatView } from '@session-chat/chat-view'
import type { ChatCommands } from '@session-chat/commands'
import { DEFAULT_THEME } from '@session-chat/core/theme'
import type { BackgroundCommandEntry } from '@session-chat/lib/background-command-roster'
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

function mount(commands: ChatCommands = {}) {
  const context = createChatContext({ theme: DEFAULT_THEME })
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
    expect(row(host)?.textContent).toContain('Background · 1 commands · 1 subagents')
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
    expect(row(host)?.textContent).toContain('Background · 1 commands')
    expect(row(host)?.textContent).not.toContain('subagents')
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
    expect(row(host)?.textContent).toContain('Background · 1 subagents')
  })
})
