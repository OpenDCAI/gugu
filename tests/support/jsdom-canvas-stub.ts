/**
 * jsdom 不实现 canvas 的 2D 上下文（要另装原生 canvas 包），`getContext` 返回 null。
 * lottie-web 在**模块加载时**就建一个 1×1 透明 canvas 当占位图（ImagePreloader.proxyImage），
 * 拿不到上下文当场抛 —— 于是任何 import 链能走到加载动效组件的测试文件是**整个起不来**，
 * 不是某条用例红（CI 实测：`Test Files 1 failed | 625 passed`，而 `Tests` 一条都没红）。
 * 真 Chromium 一直都有，这是 jsdom 缺口不是产品缺陷。
 *
 * ⚠️ 抽成共享模块是因为它必须装在**每一个可能跑到 jsdom 的 project** 上：
 * `gugu` 与 `session-main` 用的是两份不同的 setup 文件，只补一份的结果就是另一份在 CI 上炸，
 * 而本地只跑 `--project gugu` 照不出来（这条就是这么被 CI 抓到的）。
 *
 * 只补 lottie 真正碰到的那两个成员，❌ 不在这里造一个假的画布引擎。
 */
export function installJsdomCanvasStub(): void {
  // node 环境没有 window，顶层碰它会在 setup 阶段抛 ReferenceError（= 整个 project 起不来）。
  if (typeof window === 'undefined') return;
  const canvasPrototype = window.HTMLCanvasElement?.prototype;
  if (!canvasPrototype) return;
  canvasPrototype.getContext = ((type: string) =>
    type === '2d'
      ? ({
          fillStyle: '',
          fillRect() {},
        } as unknown as CanvasRenderingContext2D)
      : null) as typeof canvasPrototype.getContext;
}
