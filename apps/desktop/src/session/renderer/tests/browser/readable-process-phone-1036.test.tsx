import { afterEach, beforeEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { ToolGroupRoot, ToolGroupTrigger } from '@/components/assistant-ui/tool-group.aui'
import { PhoneBackgroundTasks } from '@/mobile/agent-watch/PhoneBackgroundTasks'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
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
  await h.render(<div className="gg-aw" style={{ width: 222, display: 'block' }}>
    <div className="gg-aw-thread-host">
      <ToolGroupRoot variant="ghost"><ToolGroupTrigger count={8} label={summary} detail={command} active /></ToolGroupRoot>
    </div>
    <PhoneBackgroundTasks tasks={{ commands: [{ id: 'c', launchToolCallId: 'c', taskId: 'bg', name: command }], subagents: [], canStop: true }} onStop={() => {}} onDismiss={() => {}} />
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
  const background = h.container.querySelector<HTMLButtonElement>('.gg-aw-bg-head')!
  await act(async () => { await page.getByRole('button', { name: background.textContent! }).click() })
  const name = h.container.querySelector<HTMLElement>('.gg-aw-bg-name')!
  expect(name.textContent).toBe(command)
  expect(getComputedStyle(name).whiteSpace).toBe('normal')
  expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth + 1)
})
