// @vitest-environment jsdom
// @@@5813 更新说明在官网上那一页,应用只负责「带不带他去、带去哪一条」。
// 这里钉的是**真的开了没有、开的是哪个地址**。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness, waitForCondition } from '../../../support/testHarness'
import { RELEASE_NOTES_SEEN_KEY } from '../../../../apps/desktop/src/lib/releaseNotes'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'

// 宿主桥:桌面端由主进程去取。这里给一个可控的替身。
// ⚠️ 必须把**同一个对象**交出去,❌ 不能 `{...hostBridge}` —— 工厂在模块加载期就跑了,
// 那时 beforeEach 还没给它装上 fetchChangelog,展开出来的是个空壳,测什么都测不到。
const hostBridge = vi.hoisted(() => ({
  capabilities: { appVersion: false },
}) as { capabilities: { appVersion: boolean }; fetchChangelog?: () => Promise<unknown> })
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: hostBridge }))

const { ReleaseNotesOpener } = await import('../../../../apps/desktop/src/components/ReleaseNotesOpener')
const { createElement } = await import('react')

const PAGE = 'https://gugu.nextmind.space/help/release-notes/macos/'
const feed = (...versions: string[]) =>
  versions.map((version) => ({ version, url: `${PAGE}#v${version}` }))

let harness: ReturnType<typeof createReactHarness>
let opened: string[]

beforeEach(() => {
  localStorage.clear()
  opened = []
  harness = createReactHarness()
  vi.stubGlobal('__APP_VERSION__', '0.2.43')
  vi.stubGlobal('open', vi.fn((url: string) => { opened.push(url) }))
  hostBridge.fetchChangelog = () => Promise.resolve(feed('0.2.43', '0.2.42'))
})

afterEach(() => {
  harness.cleanup()
  delete hostBridge.fetchChangelog
  vi.unstubAllGlobals()
})

describe('装好新版第一次打开', () => {
  it('从旧版升上来 → 自己带他去,开的是这一版那一条', async () => {
    localStorage.setItem(RELEASE_NOTES_SEEN_KEY, '0.2.42')

    await harness.render(createElement(ReleaseNotesOpener))
    await waitForCondition(() => opened.length > 0, '没有把人带到网页上')

    expect(opened).toEqual([`${PAGE}#v0.2.43`])
    expect(localStorage.getItem(RELEASE_NOTES_SEEN_KEY)).toBe('0.2.43')
  })

  it('同一个版本再开一次 → 不重复带', async () => {
    localStorage.setItem(RELEASE_NOTES_SEEN_KEY, '0.2.43')

    await harness.render(createElement(ReleaseNotesOpener))
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(opened).toEqual([])
  })

  it('全新安装 → 不带,只记住 —— 他没有"上一版"可对照', async () => {
    await harness.render(createElement(ReleaseNotesOpener))
    await waitForCondition(
      () => localStorage.getItem(RELEASE_NOTES_SEEN_KEY) === '0.2.43',
      '没有把当前版本记下来',
    )

    expect(opened).toEqual([])
  })

  it('一条都没取到(离线)→ 什么都不做,也什么都不记', async () => {
    hostBridge.fetchChangelog = () => Promise.resolve(null)
    localStorage.setItem(RELEASE_NOTES_SEEN_KEY, '0.2.42')

    await harness.render(createElement(ReleaseNotesOpener))
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(opened).toEqual([])
    // ❗ 记了这一版,等网络回来说明取到了也再不会带他去了。
    expect(localStorage.getItem(RELEASE_NOTES_SEEN_KEY)).toBe('0.2.42')
  })

  it('这一版还没写说明 → 不带他去一页空的,而且什么都不记', async () => {
    hostBridge.fetchChangelog = () => Promise.resolve(feed('0.2.42'))
    localStorage.setItem(RELEASE_NOTES_SEEN_KEY, '0.2.41')

    await harness.render(createElement(ReleaseNotesOpener))
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(opened).toEqual([])
    expect(localStorage.getItem(RELEASE_NOTES_SEEN_KEY)).toBe('0.2.41')
  })
})

describe('设置 → 关于里那一行', () => {
  it('点了就带他去这一版那一条', async () => {
    localStorage.setItem(RELEASE_NOTES_SEEN_KEY, '0.2.43')

    await harness.render(createElement(ReleaseNotesOpener))
    await waitForCondition(
      () => {
        window.dispatchEvent(new CustomEvent(UI_EVENTS.openReleaseNotes))
        return opened.length > 0
      },
      '点了没反应',
    )

    expect(opened[0]).toBe(`${PAGE}#v0.2.43`)
  })

  it('这一版没写说明 → 带他去这一端的整页,❌ 不拿上一版那一条冒充', async () => {
    hostBridge.fetchChangelog = () => Promise.resolve(feed('0.2.42'))
    localStorage.setItem(RELEASE_NOTES_SEEN_KEY, '0.2.43')

    await harness.render(createElement(ReleaseNotesOpener))
    await waitForCondition(
      () => {
        window.dispatchEvent(new CustomEvent(UI_EVENTS.openReleaseNotes))
        return opened.length > 0
      },
      '点了没反应',
    )

    expect(opened[0]).toBe(PAGE)
  })
})
