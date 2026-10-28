// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { createReactHarness } from '../../support/testHarness'

const rpc = vi.hoisted(() => ({ fetchBackgroundTasks: vi.fn() }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({ fetchBackgroundTasks: rpc.fetchBackgroundTasks }))

const { backgroundTaskRosters, usePhoneBackgroundTasks } = await import('../../../apps/desktop/src/mobile/agent-watch/background-tasks')
const { PhoneBackgroundTasks } = await import('../../../apps/desktop/src/mobile/agent-watch/PhoneBackgroundTasks')
const { dismissSubagent } = await import('../../../apps/desktop/src/session/renderer/features/sessions/view/subagent-dismissals')

const bash = (over: Record<string, unknown> = {}) => ({
  kind: 'execute-tool-call', id: 'cmd-item', seq: 1, toolCallId: 'call_bash', title: 'pnpm test', status: 'done', backgroundTaskId: 'task-42', ...over,
})
// 一轮早就收口了(后台命令不挂住这一轮),命令照样在跑。
const settled = (items: unknown[]): TranscriptTurn => ({ id: 't1', seq: 0, initiator: 'user', startedAt: Date.now() - 60_000, outcome: 'completed', items } as never)

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); rpc.fetchBackgroundTasks.mockReset() })
afterEach(() => { harness.cleanup() })

// owner 2026-10-27(#638):后台任务放进主对话。手机看会话跟电脑一致:对话末尾一句,点开是单子,能停、能收起。
describe('phone background tasks', () => {
  it('lists a background command after its turn settled, and drops it once the runtime says it is gone', () => {
    expect(backgroundTaskRosters('s1', [settled([bash()])], null).commands.map((entry) => entry.taskId)).toEqual(['task-42'])
    expect(backgroundTaskRosters('s1', [settled([bash()])], ['task-42']).commands).toHaveLength(1)
    expect(backgroundTaskRosters('s1', [settled([bash()])], []).commands).toEqual([])
    expect(backgroundTaskRosters('s1', [settled([bash({ backgroundTaskDone: true })])], null).commands).toEqual([])
  })

  it('hides a row the person dismissed, only in that session', () => {
    dismissSubagent('s-dismiss', 'cmd-item')
    expect(backgroundTaskRosters('s-dismiss', [settled([bash()])], null).commands).toEqual([])
    expect(backgroundTaskRosters('s-other', [settled([bash()])], null).commands).toHaveLength(1)
  })

  it('asks that computer which commands still run, and offers Stop only when it can answer', async () => {
    rpc.fetchBackgroundTasks.mockResolvedValue({ runningCommandTaskIds: [] })
    const seen: Array<ReturnType<typeof usePhoneBackgroundTasks>> = []
    function Probe() { seen.push(usePhoneBackgroundTasks('mac', 's2', [settled([bash()])], 0, true)); return null }
    await harness.render(createElement(Probe))
    await act(async () => { await Promise.resolve() })
    expect(rpc.fetchBackgroundTasks).toHaveBeenCalledWith('mac', 's2')
    expect(seen.at(-1)).toMatchObject({ commands: [], canStop: true })
  })

  it('keeps the list unfiltered and without Stop when an older computer has no such route', async () => {
    rpc.fetchBackgroundTasks.mockRejectedValue(new Error('no route'))
    const seen: Array<ReturnType<typeof usePhoneBackgroundTasks>> = []
    function Probe() { seen.push(usePhoneBackgroundTasks('mac', 's3', [settled([bash()])], 0, true)); return null }
    await harness.render(createElement(Probe))
    await act(async () => { await Promise.resolve() })
    expect(seen.at(-1)?.commands).toHaveLength(1)
    expect(seen.at(-1)?.canStop).toBe(false)
  })

  it('is one line until tapped; Stop reports the provider task id and × only dismisses', async () => {
    const onStop = vi.fn()
    const onDismiss = vi.fn()
    const tasks = { commands: [{ id: 'cmd-item', launchToolCallId: 'call_bash', taskId: 'task-42', name: 'pnpm test' }], subagents: [], canStop: true }
    await harness.render(createElement(PhoneBackgroundTasks, { tasks, onStop, onDismiss }))
    const root = harness.container.querySelector('[data-testid="agent-watch-background-tasks"]') as HTMLElement
    expect(root).not.toBeNull()
    expect(harness.container.querySelector('[data-testid="agent-watch-background-list"]')).toBeNull()
    await act(async () => { (root.querySelector('button') as HTMLButtonElement).click() })
    const buttons = [...harness.container.querySelectorAll<HTMLButtonElement>('[data-task-kind="command"] button')]
    expect(buttons).toHaveLength(2)
    await act(async () => { buttons[0]!.click() })
    expect(onStop).toHaveBeenCalledWith('task-42')
    await act(async () => { buttons[1]!.click() })
    expect(onDismiss).toHaveBeenCalledWith('cmd-item')
  })

  it('draws nothing when nothing runs, and no Stop for an older computer', async () => {
    await harness.render(createElement(PhoneBackgroundTasks, { tasks: { commands: [], subagents: [], canStop: true }, onStop: vi.fn(), onDismiss: vi.fn() }))
    expect(harness.container.innerHTML).toBe('')
    const tasks = { commands: [{ id: 'c', launchToolCallId: 'x', taskId: 't', name: 'sleep' }], subagents: [], canStop: false }
    await harness.render(createElement(PhoneBackgroundTasks, { tasks, onStop: vi.fn(), onDismiss: vi.fn() }))
    await act(async () => { (harness.container.querySelector('button') as HTMLButtonElement).click() })
    expect(harness.container.querySelectorAll('[data-task-kind="command"] button')).toHaveLength(1)
  })
})
