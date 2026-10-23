// @vitest-environment jsdom
// 10-08 owner 实测:Beta 后台静默下 198MB 下了 7 分钟,关于页一直只写「发现新版本」,连点四次
// 「检查更新」也一样 —— 主进程把静默下载的进度整段吞掉,状态源停在 idle/available。
// 现在「正在下」是状态源上的一个值(main.ts markDownloading),关于页问得到、也收得到推送;
// 文案沿用横幅那一句「下载新版本中…」,不另加词条。
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'

vi.stubGlobal('__APP_VERSION__', '0.2.53-beta.62.1') // vite define 的构建期常量,测试里没有
const checkForUpdates = vi.hoisted(() => vi.fn(async (): Promise<unknown> => ({ status: 'idle' })))
const installUpdate = vi.hoisted(() => vi.fn(async (): Promise<void> => {}))
const updateState = vi.hoisted(() => vi.fn(async (): Promise<unknown> => ({ status: 'idle', updateInfo: null })))
vi.mock('../../../../apps/desktop/src/platform', () => ({
  platform: {
    capabilities: { appUpdates: true, appVersion: false },
    checkForUpdates,
    updateState,
    installUpdate,
  },
}))
const { AboutSection } = await import('../../../../apps/desktop/src/components/settings/AboutSection')
const { UpdateBanner } = await import('../../../../apps/desktop/src/components/UpdateBanner')

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  checkForUpdates.mockReset()
  updateState.mockReset()
  updateState.mockResolvedValue({ status: 'idle', updateInfo: null })
})
afterEach(() => harness.cleanup())

const downloading = (percent: number) => ({
  success: true, status: 'downloading', updateInfo: { version: '0.2.53-beta.63.1' }, percent,
})
async function fire(name: string, detail: unknown) {
  await act(async () => { window.dispatchEvent(new CustomEvent(name, { detail })) })
}
const text = () => harness.container.textContent ?? ''

describe('关于页说得出「下载新版本中… N%」', () => {
  it('账户菜单移除后,关于页的问题反馈沿用原来的反馈入口', async () => {
    const open = vi.fn()
    window.addEventListener(UI_EVENTS.sessionpageOpenFeedback, open)
    try {
      await harness.render(createElement(AboutSection))
      const feedback = harness.container.querySelector<HTMLElement>('[data-testid="about-feedback"]')
      expect(feedback).not.toBeNull()
      await act(async () => { feedback!.click() })
      expect(open).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener(UI_EVENTS.sessionpageOpenFeedback, open)
    }
  })
  it('关于页提供重新查看功能引导的入口', async () => {
    const reopen = vi.fn()
    window.addEventListener(UI_EVENTS.reopenProductTour, reopen)
    try {
      await harness.render(createElement(AboutSection))
      const row = harness.container.querySelector<HTMLElement>('[data-testid="about-reopen-product-tour"]')
      expect(row).not.toBeNull()
      await act(async () => { row!.click() })
      expect(reopen).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener(UI_EVENTS.reopenProductTour, reopen)
    }
  })
  it('静默下载进行中点「检查更新」→ 下载新版本中… N%,而不是「发现新版本」', async () => {
    checkForUpdates.mockResolvedValue(downloading(41.6))
    await harness.render(createElement(AboutSection))
    const button = [...harness.container.querySelectorAll('button')].find((b) => b.textContent === '检查更新')!
    await act(async () => { button.click() })
    expect(text()).toContain('下载新版本中… 42%')
    expect(text()).not.toContain('发现新版本')
  })

  it('一进关于页就问得到正在下载,之后跟着推送走,下完换成「重启安装」', async () => {
    updateState.mockResolvedValue(downloading(10))
    await harness.render(createElement(AboutSection))
    await act(async () => { await Promise.resolve() })
    expect(text()).toContain('下载新版本中… 10%')
    await fire(UI_EVENTS.updateStatus, downloading(73))
    expect(text()).toContain('下载新版本中… 73%')
    await fire(UI_EVENTS.updateStatus, { success: true, status: 'downloaded', messageKey: 'about.updateDownloaded' })
    expect(text()).toContain('有新版本，重启安装')
  })
})

describe('@@@5576 横幅不为用户没要求的下载弹出来', () => {
  it('收到 downloading 状态(带进度),横幅仍不出现;下好了才出现', async () => {
    await harness.render(createElement(UpdateBanner))
    await fire(UI_EVENTS.updateStatus, downloading(50))
    expect(harness.container.textContent).toBe('')
    await fire(UI_EVENTS.updateStatus, { status: 'downloaded' })
    expect(text()).toContain('新版本已就绪')
  })
})

// owner 10-08:「有时候检测到新版本就不会去检测更新的版本了,就导致有时候要更新多次」。
// 按下「重启更新」时宿主先查 feed,有更新的一版就先下它(downloading),下好了接着装。界面要跟着走。
describe('按下重启更新后宿主先去下更新的一版', () => {
  it('横幅:ready → downloading(带进度)→ ready,按钮一直是「正在重启…」', async () => {
    await harness.render(createElement(UpdateBanner))
    await fire(UI_EVENTS.updateStatus, { status: 'downloaded' })
    const install = [...harness.container.querySelectorAll('button')].find((b) => b.textContent === '立即重启更新')!
    await act(async () => { install.click() })
    expect(text()).toContain('正在重启')
    await fire(UI_EVENTS.updateStatus, downloading(30))
    expect(text()).toContain('下载新版本中…')
    expect(text()).toContain('30%')
    await fire(UI_EVENTS.updateStatus, { status: 'downloaded' })
    expect(text()).toContain('新版本已就绪')
    expect(text()).toContain('正在重启')
  })

  it('关于页:下好了出「重启安装」,宿主转去下更新的一版时换成进度,下好了再出来', async () => {
    await harness.render(createElement(AboutSection))
    await fire(UI_EVENTS.updateStatus, { success: true, status: 'downloaded', messageKey: 'about.updateDownloaded' })
    expect(text()).toContain('有新版本，重启安装')
    await fire(UI_EVENTS.updateStatus, downloading(55))
    expect(text()).not.toContain('有新版本，重启安装')
    expect(text()).toContain('下载新版本中… 55%')
    await fire(UI_EVENTS.updateStatus, { success: true, status: 'downloaded', messageKey: 'about.updateDownloaded' })
    expect(text()).toContain('有新版本，重启安装')
  })
})

describe('按下重启更新:宿主查 feed 那段时间横幅照实说在检查', () => {
  it('installUpdate 还没回来 →「检查中...」;回来了 →「正在重启…」', async () => {
    let finish!: () => void
    installUpdate.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    await harness.render(createElement(UpdateBanner))
    await fire(UI_EVENTS.updateStatus, { status: 'downloaded' })
    const install = [...harness.container.querySelectorAll('button')].find((b) => b.textContent === '立即重启更新')!
    await act(async () => { install.click() })
    expect(text()).toContain('检查中...')
    expect(text()).not.toContain('正在重启')
    await act(async () => { finish() })
    expect(text()).toContain('正在重启')
  })

  it('按下后那次下载失败 → 「更新失败 + 重试」,重试下好后按钮是「立即重启更新」,❌ 卡在「正在重启…」', async () => {
    await harness.render(createElement(UpdateBanner))
    await fire(UI_EVENTS.updateStatus, { status: 'downloaded' })
    const install = [...harness.container.querySelectorAll('button')].find((b) => b.textContent === '立即重启更新')!
    await act(async () => { install.click() })
    await fire(UI_EVENTS.updateStatus, downloading(10))
    await fire(UI_EVENTS.updateStatus, { status: 'error', message: 'net::ERR_CONNECTION_RESET' })
    expect(text()).toContain('重试')
    await fire(UI_EVENTS.updateStatus, downloading(50))
    await fire(UI_EVENTS.updateStatus, { status: 'downloaded' })
    expect(text()).toContain('立即重启更新')
    expect(text()).not.toContain('正在重启')
  })
})
