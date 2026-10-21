// @vitest-environment jsdom
import { act } from 'react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
// 宿主收到下载请求就把状态值改成 'downloading'(main.ts markDownloading / capacitorAppUpdate)。
// 横幅的「下载中」只认这个状态值,❌ 自己记一份。
const downloadUpdate = vi.hoisted(() => vi.fn(async () => {
  window.dispatchEvent(new CustomEvent(UI_EVENTS.updateStatus, { detail: { status: 'downloading' } }))
}))
const installUpdate = vi.hoisted(() => vi.fn(async () => {}))
// @@@5837 宿主答「更新现在是什么状态」。默认 idle(这个进程还没查过)。
const updateState = vi.hoisted(() => vi.fn(async (): Promise<unknown> => ({ status: 'idle', updateInfo: null })))
vi.mock('../../../../apps/desktop/src/platform', () => ({
  platform: { capabilities: { appUpdates: true }, downloadUpdate, installUpdate, updateState },
}))
const { UpdateBanner } = await import('../../../../apps/desktop/src/components/UpdateBanner')
let harness: ReturnType<typeof createReactHarness>
const banner = () => harness.container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.updateBanner}"]`)
const downloadBtn = () => harness.container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.updateDownloadButton}"]`) as HTMLButtonElement | null
const installBtn = () => harness.container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.updateInstallButton}"]`) as HTMLButtonElement | null
const retryBtn = () => harness.container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.updateRetryButton}"]`) as HTMLButtonElement | null
const phase = () => banner()?.getAttribute('data-phase')
async function fire(name: string, detail?: unknown) {
  await act(async () => { window.dispatchEvent(new CustomEvent(name, detail ? { detail } : undefined)) })
}
beforeEach(() => {
  harness = createReactHarness()
  downloadUpdate.mockClear(); installUpdate.mockClear()
  updateState.mockReset()
  updateState.mockResolvedValue({ status: 'idle', updateInfo: null })
})
afterEach(() => harness.cleanup())
describe('#7496 left rail update entry', () => {
  const button = () => harness.container.querySelector<HTMLButtonElement>('button.gg-update-rail')

  it('does not occupy a rail cell when no update is available', async () => {
    await harness.render(createElement(UpdateBanner, { placement: 'rail' }))
    await fire(UI_EVENTS.updateStatus, { status: 'not-available' })
    expect(button()).toBeNull()
  })

  it('restores a ready update from the host and installs on the first click', async () => {
    updateState.mockResolvedValue({ status: 'downloaded' })
    await harness.render(createElement(UpdateBanner, { placement: 'rail' }))
    expect(button()?.getAttribute('aria-label')).toBe('立即重启更新')
    expect(banner()).toBeNull()
    await act(async () => { button()!.click(); button()!.click() })
    expect(installUpdate).toHaveBeenCalledOnce()
    expect(downloadUpdate).not.toHaveBeenCalled()
    expect(button()?.getAttribute('aria-disabled')).toBe('true')
    await act(async () => { button()!.click() })
    expect(installUpdate).toHaveBeenCalledOnce()
  })

  it('shows real background progress in place and does not restart a download on click', async () => {
    updateState.mockResolvedValue({ status: 'downloading', percent: 41.6 })
    await harness.render(createElement(UpdateBanner, { placement: 'rail' }))
    expect(button()?.getAttribute('aria-label')).toBe('下载新版本中… 42%')
    expect(button()?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('41.6')
    await act(async () => { button()!.click() })
    expect(downloadUpdate).not.toHaveBeenCalled()
    expect(installUpdate).not.toHaveBeenCalled()
    await fire(UI_EVENTS.updateStatus, { status: 'downloaded' })
    expect(button()?.getAttribute('aria-label')).toBe('立即重启更新')
    expect(button()?.querySelector('[role="progressbar"]')).toBeNull()
  })

  it('downloads an available update directly and offers retry after a download error', async () => {
    await harness.render(createElement(UpdateBanner, { placement: 'rail' }))
    await fire(UI_EVENTS.updateStatus, { status: 'available' })
    await act(async () => { button()!.click() })
    expect(downloadUpdate).toHaveBeenCalledOnce()
    await fire(UI_EVENTS.updateStatus, { status: 'error', message: 'net::ERR_CONNECTION_RESET' })
    expect(button()?.getAttribute('aria-label')).toBe('重试')
    await act(async () => { button()!.click() })
    expect(downloadUpdate).toHaveBeenCalledTimes(2)
    expect(button()?.getAttribute('aria-disabled')).toBe('true')
  })

  it('keeps the ready action when a later check reports another state', async () => {
    await harness.render(createElement(UpdateBanner, { placement: 'rail' }))
    await fire(UI_EVENTS.updateStatus, { status: 'downloaded' })
    await fire(UI_EVENTS.updateStatus, { status: 'available' })
    await fire(UI_EVENTS.updateStatus, { status: 'not-available' })
    await fire(UI_EVENTS.updateStatus, { status: 'error' })
    expect(button()?.getAttribute('aria-label')).toBe('立即重启更新')
    await act(async () => { button()!.click() })
    expect(installUpdate).toHaveBeenCalledOnce()
  })
})
describe('#1578 UpdateBanner (user-choice update prompt)', () => {
  it('renders nothing until an update event arrives', async () => {
    await harness.render(createElement(UpdateBanner))
    expect(banner()).toBeNull()
  })
  it('on update-available offers 更新/稍后 (NOT auto-downloading) with the version', async () => {
    await harness.render(createElement(UpdateBanner))
    await fire(UI_EVENTS.updateStatus, { status: 'available', updateInfo: { version: '0.2.8' } })
    expect(banner()).not.toBeNull()
    expect(banner()?.textContent).toContain('发现新版本 v0.2.8')
    expect(downloadBtn()).not.toBeNull()   // 用户选「更新」才下
    expect(installBtn()).toBeNull()
    expect(downloadUpdate).not.toHaveBeenCalled() // 不静默后台下载
  })
  it('clicking 更新 triggers downloadUpdate and moves to a downloading notice', async () => {
    await harness.render(createElement(UpdateBanner))
    await fire(UI_EVENTS.updateStatus, { status: 'available' })
    await act(async () => { downloadBtn()!.click() })
    expect(downloadUpdate).toHaveBeenCalledTimes(1)
    expect(banner()?.getAttribute('data-phase')).toBe('downloading')
    expect(banner()?.textContent).toContain('下载新版本中')
    expect(downloadBtn()).toBeNull()
    expect(installBtn()).toBeNull()
  })
  // @@@1961 下载阶段显示进度条 + 百分比(此前只有静态「下载新版本中…」,大包/慢网看着像卡死)。
  it('shows a download progress bar with live percent while downloading', async () => {
    const bar = () => harness.container.querySelector('[data-testid="update-download-progress-bar"]') as HTMLElement | null
    await harness.render(createElement(UpdateBanner))
    await fire(UI_EVENTS.updateStatus, { status: 'available' })
    await act(async () => { downloadBtn()!.click() })
    expect(banner()?.getAttribute('data-phase')).toBe('downloading')
    expect(bar()).not.toBeNull()
    expect(banner()?.textContent).toContain('准备下载…')
    expect(bar()!.style.width).toBe('0%')
    await fire(UI_EVENTS.updateStatus, { status: 'downloading', percent: 42 })
    expect(banner()?.textContent).toContain('42%')
    expect(bar()!.style.width).toBe('42%')
    await fire(UI_EVENTS.updateStatus, { status: 'downloading', percent: 87.6 })
    expect(banner()?.textContent).toContain('88%')
    expect(bar()!.style.width).toBe('88%')
  })
  it('on update-downloaded shows 立即重启更新 and installs on click', async () => {
    await harness.render(createElement(UpdateBanner))
    await fire(UI_EVENTS.updateStatus, { status: 'downloaded' })
    expect(banner()?.textContent).toContain('新版本已就绪')
    const btn = installBtn()
    expect(btn).not.toBeNull()
    await act(async () => { btn!.click() })
    expect(installUpdate).toHaveBeenCalledTimes(1)
  })
  it.each(['not-available', 'error'])('stays silent on %s (auto-check must not nag)', async (status) => {
    await harness.render(createElement(UpdateBanner))
    await fire(UI_EVENTS.updateStatus, { status })
    expect(banner()).toBeNull()
  })
  it('a repeat update-available while downloading does NOT bounce back to the choice buttons', async () => {
    await harness.render(createElement(UpdateBanner))
    await fire(UI_EVENTS.updateStatus, { status: 'available' })
    await act(async () => { downloadBtn()!.click() })
    expect(banner()?.getAttribute('data-phase')).toBe('downloading')
    await fire(UI_EVENTS.updateStatus, { status: 'available' }) // 第二次 check 命中
    expect(banner()?.getAttribute('data-phase')).toBe('downloading')
    expect(downloadBtn()).toBeNull()
  })
  it('a dismissed available notice still re-surfaces when the update becomes ready', async () => {
    await harness.render(createElement(UpdateBanner))
    await fire(UI_EVENTS.updateStatus, { status: 'available' })
    const close = banner()?.querySelector('button[aria-label="关闭"]') as HTMLButtonElement
    await act(async () => { close.click() })
    expect(banner()).toBeNull()
    await fire(UI_EVENTS.updateReady)
    expect(banner()).not.toBeNull()
    expect(installBtn()).not.toBeNull()
  })
})
describe('#663 UpdateBanner manual-install (mac dmg 半自动路径)', () => {
  it('on downloaded-manual shows drag-to-install guidance with NO restart button', async () => {
    await harness.render(createElement(UpdateBanner))
    await fire(UI_EVENTS.updateStatus, { status: 'downloaded-manual' })
    expect(banner()?.getAttribute('data-phase')).toBe('manual-install')
    expect(banner()?.textContent).toContain('安装包已打开')
    expect(banner()?.textContent).toContain('应用程序')
    expect(installBtn()).toBeNull()   // 系统接管安装,无 quitAndInstall 按钮
    expect(downloadBtn()).toBeNull()
  })
})
describe('#2126 更新失败 fail-loud(显原因 + 重试,不静默 revert 循环)+ manual-install 抗打回', () => {
  async function toDownloading() {
    await harness.render(createElement(UpdateBanner))
    await fire(UI_EVENTS.updateStatus, { status: 'available' })
    await act(async () => { downloadBtn()!.click() })
    expect(banner()?.getAttribute('data-phase')).toBe('downloading')
  }
  it('下载中失败 → 显式「更新失败」态 + 人话原因 + 重试按钮(❌ 静默回到「可更新」)', async () => {
    await toDownloading()
    await fire(UI_EVENTS.updateStatus, { status: 'error', message: 'HttpError: 404 Not Found' })
    expect(banner()?.getAttribute('data-phase')).toBe('failed')
    expect(banner()?.textContent).toContain('更新失败')
    // @@@4891 原来拿字面「404」当「显了原因」的记号。状态码已按 owner 拍板移进日志,
    expect(banner()?.textContent).toContain('安装包还没准备好')
    expect(banner()?.textContent).not.toContain('404') // 码进日志,不回显给用户
    expect(retryBtn()).not.toBeNull()
    expect(downloadBtn()).toBeNull() // 不再是「可更新」诱导反复点
  })
  it('点「重试」→ 重新下载(回 downloading + 再调 downloadUpdate),不自动循环', async () => {
    await toDownloading()
    await fire(UI_EVENTS.updateStatus, { status: 'error', message: 'boom' })
    expect(banner()?.getAttribute('data-phase')).toBe('failed')
    downloadUpdate.mockClear()
    await act(async () => { retryBtn()!.click() })
    expect(banner()?.getAttribute('data-phase')).toBe('downloading')
    expect(downloadUpdate).toHaveBeenCalledTimes(1)
  })
  // @@@2127 §2(019f64ea 复审揪出):failed 不在 available 状态保护列表 → 后台周期 check 命中 available
  it('failed 态不被后台周期 available 覆盖(粘住直到用户重试/关闭)', async () => {
    await toDownloading()
    await fire(UI_EVENTS.updateStatus, { status: 'error', message: 'HttpError: 404 Not Found' })
    expect(phase()).toBe('failed')
    await fire(UI_EVENTS.updateStatus, { status: 'available', updateInfo: { version: '0.2.24' } })
    expect(phase()).toBe('failed')
    expect(banner()?.textContent).toContain('更新失败')
    expect(retryBtn()).not.toBeNull()
    expect(downloadBtn()).toBeNull()
  })
})

// @@@5837 一条事件只发一次,而界面随时可能不在(整窗重载、用户关掉了它、下好的那一刻窗口没开)。
// 「包已经下好、等你按一下」是主进程的事实,界面挂载时就该去问它 —— 否则唯一的安装入口会凭空消失,
// 而这正是 owner 2026-09-18 撞上的:连按三次检查更新,界面上一个能按的东西都没有。
describe('#5837 挂载时向宿主问状态(不靠"正好接到过那条事件")', () => {
  it('包早就下好了 → 一条事件都没有,横幅照样出来,而且是「立即重启更新」', async () => {
    updateState.mockResolvedValue({ status: 'downloaded', updateInfo: { version: '0.2.46-beta.4.1' } })
    await harness.render(createElement(UpdateBanner))
    await act(async () => { await Promise.resolve() })
    expect(phase()).toBe('ready')
    expect(installBtn()).not.toBeNull()
    expect(banner()?.textContent).toContain('新版本已就绪')
  })

  it('宿主说什么都没有 → 照旧不弹(❌ 不能问一次就自己冒出来)', async () => {
    await harness.render(createElement(UpdateBanner))
    await act(async () => { await Promise.resolve() })
    expect(banner()).toBeNull()
  })

  it('宿主答不上来(web/移动端没有更新这件事)→ 不炸、不弹', async () => {
    updateState.mockRejectedValue(new Error('Updates unavailable'))
    await harness.render(createElement(UpdateBanner))
    await act(async () => { await Promise.resolve() })
    expect(banner()).toBeNull()
  })

  it('dmg 半自动那条路也问得到(安装包已打开,无重启按钮)', async () => {
    updateState.mockResolvedValue({ status: 'downloaded-manual', updateInfo: null })
    await harness.render(createElement(UpdateBanner))
    await act(async () => { await Promise.resolve() })
    expect(phase()).toBe('manual-install')
    expect(installBtn()).toBeNull()
  })
})
