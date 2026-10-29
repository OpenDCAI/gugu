// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  setContext: vi.fn(async () => {}), clearContext: vi.fn(async () => {}),
  listener: null as ((event: { contextId: string; key: string }) => void) | null,
  platform: 'android', available: true,
}))
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => native.platform, isPluginAvailable: () => native.available },
  registerPlugin: () => ({ setContext: native.setContext, clearContext: native.clearContext,
    addListener: vi.fn(async (_event, callback) => { native.listener = callback; return { remove: vi.fn() } }),
  }),
}))
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ error: vi.fn() }) }))
beforeEach(() => { vi.resetModules(); native.setContext.mockClear(); native.clearContext.mockClear(); native.listener = null; native.platform = 'android'; native.available = true })
const api = () => import('../../../../apps/desktop/src/platform/capacitorMessageSelection')
describe('native message selection bridge', () => {
  it('publishes dynamic capabilities including future extensions without sending executable handlers', async () => {
    const bridge = await api()
    bridge.publishNativeMessageSelection('a', [{ key: 'keep', label: 'Keep', onSelect: vi.fn() }, { key: 'delete', label: 'Delete', disabled: true }])
    await Promise.resolve()
    expect(native.setContext).toHaveBeenCalledWith({ contextId: 'a', actions: [{ key: 'keep', label: 'Keep', disabled: undefined }, { key: 'delete', label: 'Delete', disabled: true }] })
  })
  it('cannot replay old, disabled or unknown message actions after a range moves', async () => {
    const bridge = await api(), oldAction = vi.fn(), currentAction = vi.fn()
    bridge.publishNativeMessageSelection('a', [{ key: 'delete', label: 'Delete', onSelect: oldAction }])
    bridge.publishNativeMessageSelection('b', [{ key: 'forward', label: 'Forward', disabled: true, onSelect: currentAction }])
    await Promise.resolve()
    native.listener!({ contextId: 'a', key: 'delete' })
    native.listener!({ contextId: 'b', key: 'forward' })
    native.listener!({ contextId: 'b', key: 'delete' })
    expect(oldAction).not.toHaveBeenCalled(); expect(currentAction).not.toHaveBeenCalled()
    expect(native.setContext).toHaveBeenCalledTimes(1)
  })
  it('a stale clear does not remove a newer context; clearing the current context rejects late events', async () => {
    const bridge = await api(), action = vi.fn()
    bridge.publishNativeMessageSelection('b', [{ key: 'reply', label: 'Reply', onSelect: action }])
    bridge.clearNativeMessageSelection('a')
    await Promise.resolve()
    expect(native.setContext).toHaveBeenCalledOnce()
    bridge.clearNativeMessageSelection('b')
    native.listener!({ contextId: 'b', key: 'reply' })
    expect(action).not.toHaveBeenCalled()
  })
  it('dispatches the current dynamic action and releases the DOM range afterwards', async () => {
    const bridge = await api(), action = vi.fn()
    const node = document.createTextNode('Beta'); document.body.append(node)
    const range = document.createRange(); range.selectNodeContents(node)
    document.getSelection()!.addRange(range)
    bridge.publishNativeMessageSelection('b', [{ key: 'keep', label: 'Keep', onSelect: action }])
    await Promise.resolve()
    native.listener!({ contextId: 'b', key: 'keep' })
    expect(action).toHaveBeenCalledOnce()
    expect(document.getSelection()!.rangeCount).toBe(0)
    node.remove()
  })
  it('uses the native toolbar only on an Android shell with the plugin installed', async () => {
    const bridge = await api()
    expect(bridge.hasNativeMessageSelection()).toBe(true)
    native.platform = 'web'; expect(bridge.hasNativeMessageSelection()).toBe(false)
    native.platform = 'android'; native.available = false; expect(bridge.hasNativeMessageSelection()).toBe(false)
  })
})
