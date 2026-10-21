/**
 * 单测进程里顶替 lottie 播放器的替身。
 *
 * ## 为什么必须顶替(#5237)
 *
 * lottie-web 5.13.0 的发行字节里,**模块顶层**排了一条轮询:
 *
 *     4440  function checkReady() {
 *             if (document.readyState === 'complete') {
 *               clearInterval(readyStateCheckInterval);   // ← 唯一的自我清除条件
 *               searchAnimations();
 *             }
 *           }
 *     4467  var readyStateCheckInterval = setInterval(checkReady, 100);
 *
 * import 即开跑;句柄是模块作用域变量、从未对外暴露 ⇒ 组件的 `animation.destroy()` **够不着**
 * (组件那侧没有漏:layout effect 的 return 里就是 destroy)。于是任何 import 链能走到加载动效的
 * jsdom 文件都会留下一条谁也关不掉的定时器,它活过 jsdom 环境拆除,再随机把**与它无关**的 job 判红。
 *
 * ## 为什么必须装在**每一个**可能跑到 jsdom 的 project 上
 *
 * 与隔壁 `jsdom-canvas-stub.ts` 同一个道理、同一批安装点:`gugu`(`tests/support/setup.ts`)与
 * `session-main`(`apps/desktop/session-tooling/vitest-node-setup.ts`)是两份不同的 setup 文件,
 * 而两边都有走到加载动效的 import 链(session-main 那侧的实例:`acp-chat-store.session-absent.test.ts`
 * 用 `@vitest-environment jsdom` pragma)。只补一份的结果就是另一份照旧留残留。
 *
 * ## 为什么名字要在 vitest 的别名表里定死
 *
 * `lottie-web` 只声明在 `apps/desktop/package.json`,从 `tests/**` 用裸说明符**解析不到**。
 * 而 vitest 按**解析后的模块 id** 匹配 mock ⇒ 写在仓根 setup 里的 `vi.mock('lottie-web/…')`
 * 会注册在一个谁也命中不了的 id 上,**静默空转**(#5241 就是这么过的门:桩没生效,判据却绿)。
 * 别名表里那一条把这个名字定死成绝对路径,桩、出口、产品那条 import 才落在同一个 id 上。
 *
 * ## 只桩组件真正用到的几样,❌ 别桩得更全
 *
 * 桩得越全,越像"另写了一个播放器",而它永远不会和真播放器同步。
 * 真要断言"动画真的画出来了"的用例,在**自己文件里** `vi.unmock` 退回真身
 * (目前只有 `FullScreenLoader.test.tsx`)。
 */
export const lottiePlayerStub = {
  loadAnimation: () => ({
    goToAndStop: () => {},
    play: () => {},
    pause: () => {},
    destroy: () => {},
  }),
}
