// @vitest-environment jsdom
// @@@1647 回归:RemoteFolderPicker 的 elapsed 计时器必须在卸载时清。
// 原 flaky:loading 中(fetch 永不 settle → fetchPath 的 finally 永不到)卸载 → interval 仍 tick →
// setLoadElapsed on unmounted → 测试 env 拆除时 `window is not defined`,随机污染全员 CI(咬过 #1646)。
// 修复 = useEffect cleanup 卸载即 clearInterval(不依赖 async finally)。本测试锁:卸载后无遗留计时器。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
const listMock = vi.fn()
vi.mock('../../../../apps/desktop/src/lib/deviceFs', () => ({
  deviceFsListDirectory: (...args: unknown[]) => listMock(...args),
}))
import { RemoteFolderPicker } from '../../../../apps/desktop/src/components/RemoteFolderPicker'
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  listMock.mockReset()
})
afterEach(() => {
  container.remove()
  vi.useRealTimers()
})
describe('#1647 RemoteFolderPicker elapsed 计时器卸载清理', () => {
  it('loading 中卸载 → elapsed interval 被清,无遗留计时器(不再 setState on unmounted)', async () => {
    vi.useFakeTimers()
    listMock.mockReturnValueOnce(new Promise(() => {})) // 永不 resolve:loading,interval 运行,finally 永不到
    await act(async () => {
      root.render(createElement(RemoteFolderPicker, { deviceId: 'dev-leak', initialPath: '~', onSelect: vi.fn() }))
    })
    // loading 态:elapsed interval(1s)在跑。
    expect(vi.getTimerCount(), 'loading 时 elapsed interval 应在跑').toBeGreaterThan(0)
    act(() => { root.unmount() })
    // 打开即聚焦时 jsdom 自己排一个 0ms 的 selectionchange 任务,不是组件的计时器:先放掉它,
    // 1s 的 elapsed interval 若没清仍会留在下面的计数里。
    act(() => { vi.advanceTimersByTime(0) })
    // 修复点:卸载即 clearInterval → 无遗留计时器。修复前此处仍为 >0(interval 未清 → 后续 tick 污染 CI)。
    expect(vi.getTimerCount(), '卸载后 elapsed interval 应被清').toBe(0)
    // 再推进时间也不应触发任何已卸载组件的 setState(不抛)。
    expect(() => act(() => { vi.advanceTimersByTime(5000) })).not.toThrow()
  })
})
