import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { ToolGroupRoot, ToolGroupTrigger } from '@/components/assistant-ui/tool-group.aui'
import { SessionTranscriptView } from '@/components/assistant-ui/session-transcript-view.aui'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { BACKGROUND_TASKS_TOGGLE } from '@session-chat/state/flatten'
import '@/styles/tokens.css'
import '@/mobile/agent-watch/agent-watch.css'
import '@/mobile/agent-watch/phone-conversation.css'

let h: ReturnType<typeof createReactHarness>
beforeEach(() => { h = createReactHarness() })
afterEach(() => h.cleanup())

it('wraps the real phone process summary, live detail, and background command without changing copy', async () => {
  await page.viewport(390, 844)
  const summary = 'Thought 1 time, read 3 files, ran 3 shell commands, called 1 MCP tool'
  const command = 'sleep 150; printf T1036-BACKGROUND-WITH-A-LONG-OBSERVABLE-COMMAND-END'
  const stop = vi.fn(), dismiss = vi.fn()
  await h.render(<div className="gg-aw" style={{ width: 222, display: 'block' }}>
    <div className="gg-aw-thread-host">
      <ToolGroupRoot variant="ghost"><ToolGroupTrigger count={8} label={summary} detail={command} active /></ToolGroupRoot>
    </div>
    <SessionTranscriptView uri="phone-readable-background" turns={[]} mobile style={{ height: 500 }}
      backgroundTasks={{ commands: [{ id: 'c', launchToolCallId: 'c', taskId: 'bg', name: command }], subagents: [] }}
      commands={{ onStopBackgroundTask: stop, onDismissBackgroundTask: dismiss }} />
  </div>)
  const trigger = h.container.querySelector<HTMLElement>('[data-slot="tool-group-trigger"]')!
  expect(getComputedStyle(trigger).flexWrap).toBe('wrap')
  for (const slot of ['tool-group-trigger-label', 'tool-group-trigger-detail']) {
    const label = h.container.querySelector<HTMLElement>(`[data-slot="${slot}"]`)!
    expect(label.textContent).toBe(slot.endsWith('label') ? summary : command)
    expect(getComputedStyle(label).whiteSpace).toBe('normal')
    expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth + 1)
    expect(label.getBoundingClientRect().height).toBeGreaterThan(20)
  }
  const selector = `[data-collapse-id="${BACKGROUND_TASKS_TOGGLE}"]`
  await until('the current phone transcript shows its background disclosure', () => !!h.container.querySelector(selector))
  const background = h.container.querySelector<HTMLButtonElement>(selector)!
  await act(async () => { background.click() })
  await until('the shared background command is expanded', () => !!h.container.querySelector('[data-slot="background-task"][data-task-kind="command"]'))
  const row = h.container.querySelector<HTMLElement>('[data-slot="background-task"][data-task-kind="command"]')!
  const name = Array.from(row.querySelectorAll<HTMLElement>('span')).find(span => span.textContent?.replace(/\n/g, '') === command)!
  expect(name.textContent?.replace(/\n/g, '')).toBe(command)
  expect(row.title).toBe(command)
  expect(getComputedStyle(name).whiteSpace).toBe('pre-wrap')
  expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth + 1)
  const controls = row.querySelectorAll<HTMLButtonElement>('button')
  expect(controls).toHaveLength(2)
  await act(async () => { controls[0]!.click(); controls[1]!.click() })
  expect(stop).toHaveBeenCalledWith({ stopId: 'bg' })
  expect(dismiss).toHaveBeenCalledWith({ entryId: 'c' })
})
