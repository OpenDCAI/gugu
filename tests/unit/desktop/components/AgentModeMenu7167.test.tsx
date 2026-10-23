// @vitest-environment jsdom
// #7167 对话块里 Agent 私聊头部那颗模式按钮:owner 10-14「编程和通用一般是二选一」「尽量不要让用户误触」。
// gugu-dev#181 只剩通用 / 编程(❌「聊天」):分隔线上面是这条任务(以它正在用的那种命名、打勾),下面只有一个动作「切换为另一种」。
// 判的是用户看到的行与点下去递出的请求:去处 = 原样打开任务(❌ 带 view,否则会被当成换展示);动作 = 带上另一种。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentModeMenu } from '../../../../apps/desktop/src/components/chat/AgentModeMenu'
import { clickElement, createNode, createReactHarness, waitForCondition } from '../../../support/testHarness'

/** 菜单从上到下:去处记 `place:<文字>`,动作记 `action:<文字>`,分隔线记 'sep';打勾的去处后面带 ✓。 */
const layout = () =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"], [role="separator"]')).map((el) => {
    const role = el.getAttribute('role')
    if (role === 'separator') return 'sep'
    const text = el.textContent?.trim() ?? ''
    return role === 'menuitemradio' ? `place:${text}${el.getAttribute('aria-checked') === 'true' ? ' ✓' : ''}` : `action:${text}`
  })

describe('AgentModeMenu (#7167)', () => {
  let harness: ReturnType<typeof createReactHarness>
  const onOpen = vi.fn()

  beforeEach(() => {
    harness = createReactHarness()
    onOpen.mockReset()
  })
  afterEach(() => harness.cleanup())

  const open = async (taskView: 'code' | 'general' | null) => {
    await harness.render(createNode(AgentModeMenu, { taskView, busy: false, onOpen }))
    await clickElement(document.querySelector<HTMLElement>('[data-testid="agent-mode-trigger"]')!)
    await waitForCondition(() => document.querySelector('[role="menuitemradio"], [role="menuitem"]') !== null, 'mode menu opened')
  }
  const row = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!

  it('task runs in General: the button says General, General is the checked place, no Chat; the only action is the switch to Code', async () => {
    await open('general')
    expect(document.querySelector('[data-testid="agent-mode-trigger"]')?.textContent).toBe('通用')
    expect(layout()).toEqual(['place:通用 ✓', 'sep', 'action:切换为编程模式'])
  })

  it('task runs in Code: the place is Code and the switch goes to General', async () => {
    await open('code')
    expect(layout()).toEqual(['place:编程 ✓', 'sep', 'action:切换为通用模式'])
  })

  it('going to the task asks for no view; the switch asks for the other one', async () => {
    await open('general')
    await clickElement(row('agent-mode-general'))
    expect(onOpen).toHaveBeenLastCalledWith()
    await open('general')
    await clickElement(row('agent-mode-code'))
    expect(onOpen).toHaveBeenLastCalledWith('code')
  })

  it('when it cannot tell which one the task uses, it only offers to open the task — never guesses a switch', async () => {
    await open(null)
    expect(layout()).toEqual(['action:在任务中打开'])
    await clickElement(row('agent-mode-task'))
    expect(onOpen).toHaveBeenLastCalledWith()
  })
})
