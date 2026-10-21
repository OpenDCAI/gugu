/**
 * #5719 安装进度条：有分母才画定长条，没有分母一律不画百分比 —— 真 Chromium、真 CSS、真组件。
 *
 * **为什么必须真浏览器**：这条要判的是「那条子最后有多宽」，而宽度只在真排版之后才存在。
 * `style={{width:'10%'}}` 写在 DOM 上证明不了它算出来是 10% —— 轨道本身要是没宽度、
 * 或被 `overflow-hidden` 之外的东西约束住，百分比就落在别的基准上。这个仓已经吃过一次
 * 「类名在、值不对」的亏（#3480 一条未分层的 `button{padding:0}` 恒胜工具类）。
 *
 * 三条判据对着 spec（product spec）的三句话：
 *   ① 有分母 → 条子的**实测宽度**等于那个比例（40/400 MB ⇒ 轨道的 10%）。
 *   ② 没有分母 → **没有定长条**，只有不定长那一条；界面上一个百分比都不出现。
 *      少了后半句，一条画到 100% 的假进度条也能过。
 *   ③ 取消按下之后立刻变灰 —— 中止是一趟往返，重复按只会再发一条没用的请求。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'

import type { AgentInstallProgress } from '@gugu/session-core/workspace-server'
import { InstallProgressRow } from '@renderer/features/settings/agents-page/InstallProgressRow'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import '@renderer/index.css'

let root: Root
let host: HTMLDivElement

/** 主题变量挂在 emlight/emdark 上；少了它轨道的底色与高度算不出来。宽度取卡片常规宽。 */
beforeEach(() => {
  host = document.createElement('div')
  host.className = 'gugu-skin emlight'
  host.style.width = '520px'
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  root.unmount()
  host.remove()
})

function mount(progress: AgentInstallProgress | null, onCancel = () => {}): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  root.render(
    <QueryClientProvider client={client}>
      <SessionLocalizationProvider>
        <InstallProgressRow progress={progress} onCancel={onCancel} />
      </SessionLocalizationProvider>
    </QueryClientProvider>
  )
}

const downloading: AgentInstallProgress = {
  providerId: 'codex',
  phase: 'downloading',
  elapsedMs: 3_000,
  bytesDone: 1024 * 1024 * 40,
  bytesPerSecond: 1024 * 1024 * 2,
}

it('有分母时条子的实测宽度就是那个比例', async () => {
  mount({ ...downloading, bytesTotal: 1024 * 1024 * 400 })
  const track = page.getByTestId('install-progress-track')
  const bar = page.getByTestId('install-progress-determinate')
  await until('determinate bar renders', () => bar.query() != null)

  const trackWidth = (await track.element()).getBoundingClientRect().width
  const barWidth = (await bar.element()).getBoundingClientRect().width
  expect(trackWidth).toBeGreaterThan(0)
  // 40 / 400 = 10%。容差留给亚像素取整，不留给「差不多」。
  expect(barWidth / trackWidth).toBeCloseTo(0.1, 2)
})

it('没有分母时不画定长条，界面上一个百分比都不出现', async () => {
  mount(downloading)
  await until('indeterminate bar renders', () => page.getByTestId('install-progress-indeterminate').query() != null)
  expect(host.querySelector('[data-testid="install-progress-determinate"]')).toBeNull()
  expect(host.textContent ?? '').not.toMatch(/\d+\s*%/)
})

it('取消按下之后立刻变灰 —— 重复按只会再发一条没用的请求', async () => {
  const onCancel = vi.fn()
  mount({ ...downloading, bytesTotal: 1024 * 1024 * 400 }, onCancel)

  const button = page.getByRole('button')
  await until('cancel button renders', () => button.query() != null)
  const el = (await button.element()) as HTMLButtonElement
  await userEvent.click(el)

  expect(onCancel).toHaveBeenCalledTimes(1)
  await until('cancel button disables itself', () => el.disabled)
})
