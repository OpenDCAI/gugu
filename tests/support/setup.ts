import { beforeEach, vi } from 'vitest'
import { installJsdomCanvasStub } from './jsdom-canvas-stub'

// 真 lottie 播放器不进单测进程 —— 它模块顶层那条轮询关不掉,会活过 jsdom 拆除再把无关的 job 判红。
// 机制、为什么两份 setup 都要装、为什么这个名字必须在 vitest 别名表里定死:见替身模块的抬头。
// ⚠️ 出口在**用例自己的文件**里 `vi.unmock`(目前两条:LoadingIndicator / FullScreenLoader)——
//    它们的判据正是「动画真的画出来了」,对着替身断言等于把它们测的那件事取消掉。
vi.mock('lottie-web/build/player/lottie_light', async () => ({
  default: (await import('./lottie-player-stub')).lottiePlayerStub,
}))

// agent 头像的动效运行时同理不进单测进程:它的 rAF 循环在 jsdom 的残缺画布上会抛未捕获异常。机制见替身模块抬头。
vi.mock('../../apps/desktop/src/components/agentAvatar/engine/runtime', async () => ({
  runtime: (await import('./agent-avatar-runtime-stub')).agentAvatarRuntimeStub,
}))

// 这个 setup 同时服务两种环境:`gugu` project 的默认环境是 node(实测 463 个文件里 72% 从不碰 DOM,
// 而每个 jsdom 文件要多付 ~335ms 的建环境开销),只有第一行写了 `// @vitest-environment jsdom`
// 的文件才拿到 window。
// 下面这段是**给 jsdom 补浏览器缺口**用的,node 下没有 window 可补,必须跳过 ——
// ❌ 别删这个判断:node 环境下顶层访问 window 会在 setup 阶段抛 ReferenceError,
// 那不是某个用例红,是整个 project 起不来。
if (typeof window !== 'undefined') {
  // jsdom omits ResizeObserver; ChatAreaPanel's open-at-bottom re-pin observer (#781) uses it.
  // Provide a no-op so component mount tests don't throw. Real Chromium always has it.
  class ResizeObserverMock {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver

  // Shared rich-text composers use native caret geometry and popup scrolling. jsdom has no layout.
  Element.prototype.scrollIntoView = () => {}
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 20)
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  document.elementFromPoint = () => null

  const storage = new Map<string, string>()

  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      get length() {
        return storage.size
      },
      key(index: number) {
        return Array.from(storage.keys())[index] ?? null
      },
      getItem(key: string) {
        return storage.get(key) ?? null
      },
      setItem(key: string, value: string) {
        storage.set(key, value)
      },
      removeItem(key: string) {
        storage.delete(key)
      },
      clear() {
        storage.clear()
      },
    },
  })

  // canvas 的 2D 上下文缺口 —— 说明与「为什么必须每个 project 都装」见该模块抬头。
  installJsdomCanvasStub()
}

beforeEach(async () => {
  const { setLocalePreference } = await import('../../apps/desktop/src/i18n')
  await import('../../apps/desktop/src/i18n/registerMainCatalog')
  await import('../../apps/desktop/src/i18n/registerSettingsCatalog')
  await import('../../apps/desktop/src/i18n/registerMessagingCatalog')
  await import('../../apps/desktop/src/i18n/registerContactsCatalog')
  await import('../../apps/desktop/src/i18n/registerAgentsCatalog')
  setLocalePreference('zh-CN')
})
