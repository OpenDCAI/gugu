// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ScheduleMetaPart } from '../../../apps/desktop/src/mobile/agent-watch/schedule-meta'
import { createReactHarness } from '../../support/testHarness'

// 手机任务行上「这个任务还会回来」那一段(#7221 schedule_create 的反馈):没有悬停,时间直接写在行上。

let harness: ReturnType<typeof createReactHarness>

beforeEach(() => {
  harness = createReactHarness()
})

afterEach(() => {
  harness.cleanup()
})

const part = () => harness.container.querySelector('[data-testid="agent-watch-session-schedule"]')

// 本地时间拼的时刻:「今天 / 明天」按本地日历日分,❌ 依赖跑测试那台机器的时区。
const NOW = new Date(2026, 9, 19, 10, 0, 0).getTime()

describe('ScheduleMetaPart', () => {
  it('今天的只写时刻,带时钟、不是警示', async () => {
    await harness.render(
      <ScheduleMetaPart now={NOW} schedule={{ count: 2, nextAt: new Date(2026, 9, 19, 10, 30).toISOString(), title: '检查 CI 结果', attention: null }} />,
    )
    expect(part()?.textContent).toBe('10:30')
    expect(part()?.getAttribute('data-attention')).toBeNull()
    expect(part()?.querySelector('svg')).not.toBeNull()
    // 读屏说全:几条、下一个几点、做什么。
    expect(part()?.getAttribute('aria-label')).toContain('检查 CI 结果')
  })

  it('明天的带「明天」', async () => {
    await harness.render(
      <ScheduleMetaPart now={NOW} schedule={{ count: 1, nextAt: new Date(2026, 9, 20, 9, 30).toISOString(), title: '汇报', attention: null }} />,
    )
    expect(part()?.textContent).toMatch(/09:30/)
    expect(part()?.textContent).not.toBe('09:30')
  })

  it('最近一次没送到:换成警示,写「没送到」而不是时间', async () => {
    await harness.render(
      <ScheduleMetaPart
        now={NOW}
        schedule={{ count: 2, nextAt: new Date(2026, 9, 19, 10, 30).toISOString(), title: '检查 CI 结果', attention: { kind: 'failed', title: '回归汇总' } }}
      />,
    )
    expect(part()?.getAttribute('data-attention')).toBe('true')
    expect(part()?.textContent).not.toContain('10:30')
  })
})
