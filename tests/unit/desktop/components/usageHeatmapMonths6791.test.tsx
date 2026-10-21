// @vitest-environment jsdom
//
// #6791 热力图月份标签按周列绝对定位:手机上挨着的月份会压字,只画离上一个足够远的那些。
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

const shell = vi.hoisted(() => ({ mobile: true }))
vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => shell.mobile }))

const { UsageHeatmap } = await import('../../../../apps/desktop/src/components/usage/UsageHeatmap')

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

async function monthLefts(): Promise<number[]> {
  await harness.render(createElement(UsageHeatmap, { data: [], today: '2026-09-29', formatValue: (n: number) => String(n) }))
  return Array.from(harness.container.querySelectorAll<HTMLElement>('.gg-usage-months span')).map((el) => parseFloat(el.style.left))
}
const WEEK = 100 / 54 // 一周占整宽的百分比(铺 53–54 周,取宽松那头)

describe('UsageHeatmap 月份标签', () => {
  it('手机:相邻两个至少隔 6 周(隔一个月标一次)', async () => {
    shell.mobile = true
    const lefts = await monthLefts()
    expect(lefts.length).toBeGreaterThanOrEqual(5)
    for (let i = 1; i < lefts.length; i++) expect(lefts[i] - lefts[i - 1]).toBeGreaterThanOrEqual(6 * WEEK - 0.01)
  })

  it('桌面:每个月都标,只躲开开头不满 3 周的残月', async () => {
    shell.mobile = false
    const lefts = await monthLefts()
    expect(lefts.length).toBeGreaterThanOrEqual(11)
    expect(lefts[0], '2026-09-29 往回 371 天从 9 月 24 日开始:只露出 7 天的九月不标').toBeGreaterThan(0)
    for (let i = 1; i < lefts.length; i++) expect(lefts[i] - lefts[i - 1]).toBeGreaterThanOrEqual(3 * WEEK - 0.01)
  })
})
