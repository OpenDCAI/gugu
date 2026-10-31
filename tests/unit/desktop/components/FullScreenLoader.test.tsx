// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
/**
 * ⚠️ 这一条文件**要真播放器**。
 *
 * `tests/support/setup.ts` 默认把 lottie 桩掉(理由见 `tests/support/lottie-player-stub.ts` 的抬头:
 * 模块级定时器关不掉,会活过 jsdom 拆除,把与它无关的 job 判红)。但**本文件的判据正是「动画真的
 * 挂上去了」** —— 下面那句 `querySelector('svg')` 只在播放器起不来时才会红。对着替身断言的话,
 * 这条判据对"播放器起不来"永远为真,等于把它测的那件事取消掉。
 * ⇒ 只在这里退回真身;别的 jsdom 测试没有这个需要,也就不该付那个残留的代价。
 *
 * ⚠️ 这里写的说明符必须与桩那侧**一字不差** —— 两边都靠 vitest 别名表里那一条解析到同一个
 *    绝对路径(见 vitest.config.ts)。任何一侧改成别的写法,出口就静默失效:桩仍然生效,
 *    而本文件的真渲染判据当场红。
 */
vi.unmock('lottie-web/build/player/lottie_light')
/**
 * ⚠️ 在**真播放器被 import 之前**把 jsdom 的 `readyState` 定成 `complete`。
 *
 * 这不是无关的样板:真播放器模块顶层那条 `setInterval(checkReady, 100)` 的**唯一**自我清除条件
 * 就是 `document.readyState === 'complete'`(lottie_light.js:4440)。定成 complete,它第一次 tick
 * 就自己撤掉;不定,它在本文件里永远撤不掉 —— 那正是 #5237 的残留。
 */
/**
 * ⚠️ 但「第一次 tick 就撤掉」要那一 tick **落在本文件结束之前**:本文件的用例只要几十毫秒(CI 实测 76ms),
 * 跑完 jsdom 就拆了;tick 晚到(负载高时事件循环把它推后)就落在拆除之后,读 `document` 抛
 * ReferenceError,整片单测判红(OpenDCAI/gugu#106 的 CI)。所以这里记下那一条轮询,用例结尾等它真的撤掉。
 */
const readiness = vi.hoisted(() => {
  Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true })
  let checkReady: unknown
  let markCleared = () => {}
  const cleared = new Promise<void>((resolve) => (markCleared = resolve))
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.setInterval = ((handler: unknown, ...rest: unknown[]) => {
    const handle = (realSetInterval as (...args: unknown[]) => unknown)(handler, ...rest)
    if (typeof handler === 'function' && handler.name === 'checkReady') checkReady = handle
    return handle
  }) as typeof setInterval
  globalThis.clearInterval = ((handle?: Parameters<typeof clearInterval>[0]) => {
    if (checkReady !== undefined && handle === checkReady) markCleared()
    realClearInterval(handle)
  }) as typeof clearInterval
  return { cleared, found: () => checkReady !== undefined }
})
import { FullScreenLoader } from '../../../../apps/desktop/src/components/FullScreenLoader'
import { awaitPending } from '../../../support/awaitFact'
import { createReactHarness } from '../../../support/testHarness'
describe('FullScreenLoader', () => {
  it('冷启动那一屏用的是全产品统一的加载态，不是自己另画的', async () => {
    const harness = createReactHarness()
    await harness.render(<FullScreenLoader />)
    expect(harness.container.querySelector('[data-testid="full-screen-loader"]')).not.toBeNull()
    const indicator = harness.container.querySelector('[data-testid="loading-indicator"]')
    expect(indicator).not.toBeNull()
    expect(indicator?.getAttribute('data-gg-loading')).toBe('page')
    expect(
      harness.container.querySelector('[data-testid="loading-indicator-canvas"] svg')
    ).not.toBeNull()
    harness.cleanup()
    // 没记到那条轮询(播放器换了写法)就当场红,❌ 在下面那句上无限等。
    expect(readiness.found()).toBe(true)
    await awaitPending('真 lottie 播放器的 checkReady 轮询自己撤掉', readiness.cleared)
  })
})
