// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
/**
 * 行内一档(#6264)。owner:「这个加载中应该是我们的加载中,而不是一个 icon 手动旋转」。
 * 判据是「行内那一档播的就是同一份素材」—— 所以和 FullScreenLoader.test.tsx 一样要真播放器,
 * 退桩与 readyState 两段的理由见那个文件的抬头,说明符必须一字不差。
 */
vi.unmock('lottie-web/build/player/lottie_light')
vi.hoisted(() => {
  Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true })
})
import { LoadingIndicator } from '../../../../apps/desktop/src/lib/loading/LoadingIndicator'
import { createReactHarness } from '../../../support/testHarness'

describe('LoadingIndicator size="inline"', () => {
  it('放进按钮里也合法(全是 span),播的是同一份动画,旁边有字时对读屏隐藏', async () => {
    const harness = createReactHarness()
    await harness.render(
      <button type="button">
        <LoadingIndicator size="inline" className="text-live" />
        连接中
      </button>
    )
    const indicator = harness.container.querySelector('[data-testid="loading-indicator"]')
    expect(indicator?.tagName).toBe('SPAN')
    expect(indicator?.getAttribute('data-gg-loading')).toBe('inline')
    expect(indicator?.getAttribute('aria-hidden')).toBe('true')
    expect(indicator?.getAttribute('role')).toBeNull()
    expect(indicator?.classList.contains('text-live')).toBe(true)
    expect(harness.container.querySelector('button div')).toBeNull()
    expect(harness.container.querySelector('[data-testid="loading-indicator-canvas"] svg')).not.toBeNull()
    harness.cleanup()
  })

  it('单独出现、要自己说清在等什么时,是一个带名字的 status', async () => {
    const harness = createReactHarness()
    await harness.render(<LoadingIndicator size="inline" ariaLabel="正在刷新" />)
    const indicator = harness.container.querySelector('[data-testid="loading-indicator"]')
    expect(indicator?.getAttribute('role')).toBe('status')
    expect(indicator?.getAttribute('aria-label')).toBe('正在刷新')
    expect(indicator?.getAttribute('aria-hidden')).toBeNull()
    harness.cleanup()
  })
})
