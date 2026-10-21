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
vi.hoisted(() => {
  Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true })
})
import { FullScreenLoader } from '../../../../apps/desktop/src/components/FullScreenLoader'
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
  })
})
