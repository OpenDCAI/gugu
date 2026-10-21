/**
 * 单测进程里顶替 agent 头像动效运行时的替身。
 *
 * 真运行时(`components/agentAvatar/engine/runtime.ts`)在第一次注册时起一条全局 rAF 循环、每帧往画布上画。
 * jsdom 里画布只有 `jsdom-canvas-stub.ts` 那两个成员,循环一画就 `ctx.setTransform is not a function`,
 * 作为未捕获异常把**无关**用例的整个文件判红。单测断言的是「这一格渲染了小鸟这块 canvas、状态属性对不对」,
 * 不是「画出了什么像素」—— 后者是真浏览器里的取证(见 PR 描述的截图),不是单测的事。
 *
 * 只桩组件碰到的那几个成员,❌ 别桩得更全:桩得越全,越像「另写了一个引擎」。
 */
export const agentAvatarRuntimeStub = {
  register: () => ({
    engine: { crop: 'full', gain: 1, rotate: true, setState() {}, setExpression() {}, setBodyColor() {}, poke() {}, hop() {} },
    outfit: { set() {} },
    opts: {},
  }),
  unregister: () => {},
  // 定格(posters.ts)在单测里画不出来:一直是打包的同色那张
  still: () => new Promise<string>(() => {}),
}
