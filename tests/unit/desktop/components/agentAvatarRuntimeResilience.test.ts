// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 这一份测的就是真运行时(全局 setup 里把它换成了替身):只把 GL 与逐帧绘制换成记账的替身,
// 看每一帧拿哪一份 GL 去画 —— null = 2D 定格退路;没有这一帧 = 被跳过(画面停在上一帧)。
vi.unmock('../../../../apps/desktop/src/components/agentAvatar/engine/runtime')

const fake = vi.hoisted(() => ({
  draws: [] as unknown[],
  loads: [] as boolean[],
  made: [] as Array<{ canvas: HTMLCanvasElement; loaded: Set<string>; has(id: string): boolean; room(w: number, h: number, n: number): boolean; reset(): void }>,
  allocate: null as ((w: number, h: number) => void) | null,
  createFails: 0,
  /** drawnLook 这一帧报的样子:测试改它 = 画面变了 */
  look: [0] as number[],
  /** 第二只起各自报的样子(按 register 的次序叫 b1、b2…;第一只叫 b0,用 look) */
  lookOf: new Map<string, number[]>(),
  ids: new Map<unknown, string>(),
  /** paintGL / drawAvatar 依次被谁调了:同一趟应当先全部 paint 再全部 copy */
  order: [] as string[],
  focused: true,
  canvas: null as HTMLCanvasElement | null,
  intersect: null as ((entries: Array<{ target: Element; isIntersecting: boolean }>) => void) | null,
}))

vi.mock('../../../../apps/desktop/src/components/agentAvatar/engine/draw', async (orig) => {
  const real = await orig<typeof import('../../../../apps/desktop/src/components/agentAvatar/engine/draw')>()
  return {
    lookDiff: real.lookDiff,
    glPasses: () => 1,
    paintGL: (_gl: unknown, f: unknown, o: { w: number; h: number }) => {
      if (!fake.ids.has(f)) return { at: [0, 0], next: 0 }
      fake.allocate?.(o.w, o.h)
      fake.order.push(`paint:${fake.ids.get(f)}`)
      return { at: [0, 0], next: 0 }
    },
    drawAvatar: (_ctx: unknown, gl: unknown, _s: unknown, f: unknown) => {
      // 只记这一条用例 boot 的头像:前面用例的运行时还挂在同一个 window 的事件上,窗口事件一来它们也会醒
      if (!fake.ids.has(f)) return
      fake.draws.push(gl)
      fake.order.push(`copy:${fake.ids.get(f)}`)
    },
    drawnLook: (f: unknown, _o: unknown, out: number[]) => {
      out.length = 0
      out.push(...(fake.lookOf.get(fake.ids.get(f) ?? '') ?? fake.look))
      return out
    },
  }
})

vi.mock('../../../../apps/desktop/src/components/agentAvatar/engine/gl', () => {
  const on = (canvas: HTMLCanvasElement) => {
    const loaded = new Set<string>()
    const gl = { canvas, loaded, has: (id: string) => loaded.has(id), room: () => true, reset: () => {} }
    fake.made.push(gl)
    return gl
  }
  return {
    GuguGL: {
      create: () => {
        if (fake.createFails > 0) {
          fake.createFails--
          return null
        }
        return on(document.createElement('canvas'))
      },
      on,
    },
    loadCharacter: async (gl: { loaded: Set<string> }, ch: { id: string }) => {
      const ok = fake.loads.shift() ?? true
      if (ok) gl.loaded.add(ch.id)
      return ok
    },
    spriteUrl: (p: { sprite: string }) => p.sprite,
  }
})

let frames: FrameRequestCallback[] = []
const stops: Array<() => void> = []
/** 一帧:时间往前走 16ms(假的 performance.now 跟着走),排着的 rAF 一起跑 */
function step() {
  vi.advanceTimersByTime(16)
  const due = frames
  frames = []
  for (const cb of due) cb(performance.now())
}
const lastDraw = () => fake.draws[fake.draws.length - 1]

async function boot(birds = 1, dpr = 1, tracking = false) {
  vi.resetModules()
  const { runtime } = await import('../../../../apps/desktop/src/components/agentAvatar/engine/runtime')
  for (let i = 0; i < birds; i++) {
    const canvas = document.createElement('canvas')
    document.body.append(canvas)
    if (i === 0) fake.canvas = canvas
    const h = runtime.register(canvas, { shape: 'free', bg: false, crop: 'full', fx: false, tracking }, 1 + i, dpr, 'fjj-beak')
    fake.ids.set(h!.engine.frame, `b${i}`)
    stops.push(() => { runtime.unregister(h!); canvas.remove() })
    fake.intersect!([{ target: canvas, isIntersecting: true }])
  }
  await Promise.resolve()
  await Promise.resolve()
  return runtime
}
const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] })

beforeEach(() => {
  fake.draws.length = 0
  fake.loads.length = 0
  fake.made.length = 0
  fake.allocate = null
  fake.createFails = 0
  fake.look = [0]
  fake.lookOf.clear()
  fake.ids.clear()
  fake.order.length = 0
  fake.focused = true
  fake.intersect = null
  frames = []
  vi.spyOn(document, 'hasFocus').mockImplementation(() => fake.focused)
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(cb: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void) {
        fake.intersect = cb
      }
      observe() {}
      unobserve() {}
    },
  )
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb)
    return frames.length
  })
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
})
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('只画会变的帧、按变了多少决定什么时候画,看不见就停(Chole 上咕咕入口那只鸟 60 fps 一直画;mac1 上 24 只闲鸟半个核)', () => {
  it('和上一张差不到半个 CSS 像素就不画、也不排 rAF(改用计时器:共用时钟的下一格或下一次眨眼,哪个先到那时看)', async () => {
    fakeClock()
    await boot()
    step()
    expect(fake.draws, '第一帧要画').toHaveLength(1)
    expect(frames, '第一帧算一下变很多:接着排 rAF').toHaveLength(1)
    fake.look = [0.4]
    step()
    expect(fake.draws, '差 0.4 个像素:同一张,不画').toHaveLength(1)
    expect(frames, '没画就不排 rAF(排着就算不画,Chromium 每帧也要出一遍帧)').toHaveLength(0)
    await vi.advanceTimersByTimeAsync(330)
    expect(fake.draws, '计时器看了几次,都还是同一张').toHaveLength(1)
    expect(frames).toHaveLength(0)
  })

  it('一下变得多(眨眼、蹦、跳视…):下一趟就画,并回到 rAF 全帧率', async () => {
    fakeClock()
    await boot()
    step()
    step()
    expect(frames).toHaveLength(0)
    fake.look = [2]
    await vi.advanceTimersByTimeAsync(100)
    expect(fake.draws, '变了 2 个像素:计时器最迟下一格醒来就画').toHaveLength(2)
    expect(frames, '画了快动作回到 rAF').toHaveLength(1)
  })

  it('慢慢在变(呼吸、摆、视线游走):攒到共用的 100ms 时钟上,几只鸟同一趟一起画,画完不排 rAF', async () => {
    fakeClock()
    await boot(2)
    step()
    step()
    const drawn = fake.draws.length
    // 落在共用时钟一格的中段(这一格的第一趟已经过了,计时器要等到下一格):第一只先变,33ms 后第二只再变,都还在这一格里
    while (performance.now() % 100 < 40 || performance.now() % 100 > 50) await vi.advanceTimersByTimeAsync(1)
    fake.look = [1]
    await vi.advanceTimersByTimeAsync(33)
    expect(fake.draws.length, '这一格还没走完:先不画').toBe(drawn)
    fake.lookOf.set('b1', [1])
    // 走到共用时钟的下一格为止:两只各自在不同时刻开始变,都等到那一格
    let passes = 0
    while (fake.draws.length === drawn && passes++ < 10) await vi.advanceTimersByTimeAsync(33)
    expect(fake.draws.length - drawn, '两只在同一趟里画').toBe(2)
    expect(passes, '最多晚一格(100ms)').toBeLessThanOrEqual(4)
    expect(frames, '只有慢变化:不排 rAF').toHaveLength(0)
  })

  it('眼睛正跟着光标的大头像(光标在窗里):小变化也马上画、全帧率,❌ 眼珠一格一格跳', async () => {
    fakeClock()
    await boot(1, 1, true)
    step()
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 10 }))
    step()
    const drawn = fake.draws.length
    fake.look = [0.8]
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 12, clientY: 10 }))
    step()
    expect(fake.draws.length, '差 0.8 个像素:光标一动就醒,跟光标时不等共用时钟').toBe(drawn + 1)
    expect(frames, '接着排 rAF').toHaveLength(1)
  })

  it('像素按设备像素比算:dpr 2 的画布上差 0.8 个设备像素仍是同一张', async () => {
    fakeClock()
    await boot(1, 2)
    step()
    step()
    fake.look = [0.8]
    await vi.advanceTimersByTimeAsync(330)
    expect(fake.draws).toHaveLength(1)
  })

  it('同一趟要画的几只:先全部画进共用 GL 画布,再挨个抄走(❌ 画一只抄一只)', async () => {
    fakeClock()
    await boot(3)
    step()
    expect(fake.order).toEqual(['paint:b0', 'paint:b1', 'paint:b2', 'copy:b0', 'copy:b1', 'copy:b2'])
  })

  it('主进程报窗口看不见(最小化、收进托盘):循环停下;报回看得见就接着', async () => {
    fakeClock()
    await boot()
    step()
    window.dispatchEvent(new CustomEvent('__window_seen', { detail: false }))
    fake.look = [5]
    step()
    await vi.advanceTimersByTimeAsync(330)
    expect(fake.draws, '看不见:一张都不画').toHaveLength(1)
    expect(frames).toHaveLength(0)
    expect(vi.getTimerCount(), '也不留计时器空转').toBe(0)
    window.dispatchEvent(new CustomEvent('__window_seen', { detail: true }))
    step()
    expect(fake.draws, '看得见了接着画').toHaveLength(2)
  })

  it('窗口没焦点但看得见(副屏、并排、点进了咕咕自己的浏览器页签):照样画会变的帧', async () => {
    fakeClock()
    await boot()
    step()
    fake.focused = false
    fake.look = [2]
    step()
    expect(fake.draws, '没焦点也画变了的那一张').toHaveLength(2)
    expect(frames, '画了接着排 rAF').toHaveLength(1)
  })

  it('一只头像都不在视口里:循环停下;有一只进了视口就接着', async () => {
    fakeClock()
    await boot()
    step()
    fake.intersect!([{ target: fake.canvas!, isIntersecting: false }])
    step()
    expect(frames).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    fake.intersect!([{ target: fake.canvas!, isIntersecting: true }])
    expect(frames).toHaveLength(1)
  })

  it('保留布局的面板切到 inert 后不计算或绘制头像,切回不靠 IO 通知也能恢复', async () => {
    fakeClock()
    await boot()
    const canvas = fake.canvas!
    const panel = document.createElement('div')
    document.body.append(panel)
    panel.append(canvas)
    const { GuguEngine } = await import('../../../../apps/desktop/src/components/agentAvatar/engine/engine')
    const updates = vi.spyOn(GuguEngine.prototype, 'update')
    step()
    expect(updates).toHaveBeenCalledTimes(1)
    expect(fake.draws).toHaveLength(1)
    panel.setAttribute('inert', '')
    await Promise.resolve()
    fake.look = [5]
    updates.mockClear()
    step()
    await vi.advanceTimersByTimeAsync(330)
    expect(updates, 'IO 仍相交,但隐藏面板里的引擎不再计算').not.toHaveBeenCalled()
    expect(fake.draws, '上一次内容保留,不重画').toHaveLength(1)
    panel.removeAttribute('inert')
    await vi.advanceTimersByTimeAsync(100)
    expect(updates).toHaveBeenCalledTimes(1)
    expect(fake.draws, '没有 IO 事件也能恢复').toHaveLength(2)
  })
})

describe('小鸟的绘图层出岔子时不整只空白', () => {
  it('小头像后绘制超出原画布的大预览:先保留已画内容,再扩容,循环继续绘制', async () => {
    fakeClock()
    const runtime = await boot()
    const { GuguGL } = await vi.importActual<typeof import('../../../../apps/desktop/src/components/agentAvatar/engine/gl')>('../../../../apps/desktop/src/components/agentAvatar/engine/gl')
    // 只替代 GPU 指令,空间申请与 begin 使用真实分配器。
    const context = new Proxy({}, { get: (_target, prop) => {
      if (prop === 'isContextLost') return () => false
      if (prop === 'getShaderParameter' || prop === 'getProgramParameter') return () => true
      if (typeof prop === 'string' && /^[A-Z0-9_]+$/.test(prop)) return 0
      return () => ({})
    } }) as WebGL2RenderingContext
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 512
    canvas.getContext = (() => context) as unknown as typeof canvas.getContext
    const allocation = GuguGL.on(canvas)!
    fake.made[0].room = allocation.room.bind(allocation)
    fake.made[0].reset = allocation.reset.bind(allocation)
    fake.allocate = (w, h) => { allocation.begin(w, h) }
    const preview = document.createElement('canvas')
    document.body.append(preview)
    preview.width = preview.height = 656
    const handle = runtime.register(preview, { shape: 'free', bg: false, crop: 'full', fx: false, tracking: false }, 2, 2, 'fjj-beak')!
    fake.ids.set(handle.engine.frame, 'preview')
    stops.push(() => { runtime.unregister(handle); preview.remove() })
    fake.intersect!([{ target: preview, isIntersecting: true }])

    expect(() => step()).not.toThrow()
    expect(fake.order).toEqual(['paint:b0', 'copy:b0', 'paint:preview', 'copy:preview'])
    expect(canvas.width).toBeGreaterThanOrEqual(656)
    expect(canvas.height).toBeGreaterThanOrEqual(656)
    fake.look = [10]
    step()
    expect(fake.draws.length).toBeGreaterThanOrEqual(3)
    expect(fake.order.slice(-2)).toEqual(['paint:preview', 'copy:preview'])
  })

  it('共用的 WebGL 上下文被收走:退回 2D 定格接着画;随即在一张新画布上重建、重载素材,再回到 GL', async () => {
    fakeClock()
    const runtime = await boot()
    step()
    const first = fake.made[0]
    expect(lastDraw()).toBe(first)

    first.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    expect(runtime.usingGL).toBe(false)
    const before = fake.draws.length
    step()
    expect(fake.draws.length, '这一帧照样画了').toBe(before + 1)
    expect(lastDraw(), '用 2D 定格画,❌ 拿作废的纹理画').toBeNull()

    // ❌ 等旧画布的 webglcontextrestored(Electron 44 实测等不来):过一小会儿自己在新画布上重建
    await vi.advanceTimersByTimeAsync(500)
    const second = fake.made[1]
    expect(second, '重建了一份 GL').toBeDefined()
    expect(second.canvas, '新画布,不是那张丢过的').not.toBe(first.canvas)
    expect(runtime.usingGL).toBe(true)
    step()
    expect(lastDraw(), '素材重载进新上下文,回到 GL').toBe(second)

    // 旧画布后来又报什么都与现在这份无关
    first.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    expect(runtime.usingGL).toBe(true)
  })

  it('刚重建的 GL 又丢了:下一次重建按下一档等,❌ 每 500ms 建一个新上下文空转', async () => {
    fakeClock()
    const runtime = await boot()
    fake.made[0].canvas.dispatchEvent(new Event('webglcontextlost'))
    await vi.advanceTimersByTimeAsync(500)
    expect(fake.made).toHaveLength(2)

    fake.made[1].canvas.dispatchEvent(new Event('webglcontextlost'))
    await vi.advanceTimersByTimeAsync(500)
    expect(fake.made, '500ms 时还不重建').toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(fake.made, '下一档(2s)到了才重建').toHaveLength(3)
    expect(runtime.usingGL).toBe(true)
  })

  it('新画布上也拿不到 WebGL:继续用 2D 定格画,过一会儿再试', async () => {
    fakeClock()
    const runtime = await boot()
    fake.createFails = 1
    fake.made[0].canvas.dispatchEvent(new Event('webglcontextlost'))
    await vi.advanceTimersByTimeAsync(500)
    expect(runtime.usingGL).toBe(false)
    step()
    expect(lastDraw()).toBeNull()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(runtime.usingGL).toBe(true)
  })

  it('一启动就拿不到 WebGL(比如界面进程崩溃重载那一刻 GPU 还没起来):先画定格,随后照样在新画布上再试,❌ 整个会话停在定格', async () => {
    fakeClock()
    fake.createFails = 1
    const runtime = await boot()
    expect(runtime.usingGL).toBe(false)
    step()
    expect(lastDraw(), '拿不到时用 2D 定格画着').toBeNull()
    await vi.advanceTimersByTimeAsync(500)
    expect(runtime.usingGL).toBe(true)
    await Promise.resolve()
    step()
    expect(lastDraw()).toBe(fake.made[0])
  })

  it('素材这次没载下来:先用 2D 定格画着(❌ 一直跳过),过一会儿再试,载下来就回到 GL', async () => {
    fakeClock()
    fake.loads.push(false)
    await boot()
    step()
    expect(fake.draws, '载失败了也要画').toHaveLength(1)
    expect(lastDraw()).toBeNull()

    await vi.advanceTimersByTimeAsync(15_000)
    step()
    expect(lastDraw()).toBe(fake.made[0])
  })
})
