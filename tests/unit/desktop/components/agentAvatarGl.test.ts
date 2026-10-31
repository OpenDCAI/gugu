// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GuguGL } from '../../../../apps/desktop/src/components/agentAvatar/engine/gl'

/** 一个什么都不做、什么都答「成了」的 WebGL2 上下文:只为让建管线、载图那几步走得通 */
function fakeContext(lost = false, draws: unknown[] = []): WebGL2RenderingContext {
  let bound: unknown = null
  return new Proxy({} as Record<string | symbol, unknown>, {
    get(_target, prop) {
      if (prop === 'isContextLost') return () => lost
      if (prop === 'bindTexture') return (_t: unknown, tex: unknown) => (bound = tex)
      if (prop === 'drawElements') return (_m: unknown, n: number) => draws.push([bound, n])
      if (prop === 'getShaderParameter' || prop === 'getProgramParameter') return () => true
      if (prop === 'getExtension') return () => null
      if (typeof prop === 'string' && /^[A-Z0-9_]+$/.test(prop)) return 0
      return () => ({})
    },
  }) as unknown as WebGL2RenderingContext
}

function canvasWith(context: WebGL2RenderingContext | null): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.getContext = (() => context) as unknown as typeof canvas.getContext
  return canvas
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('共用 GL 画布', () => {
  it('拿不到上下文、或拿到的是已被收走的上下文:不建(调用方走 2D 定格)', () => {
    expect(GuguGL.on(canvasWith(null))).toBeNull()
    expect(GuguGL.on(canvasWith(fakeContext(true)))).toBeNull()
    expect(GuguGL.on(canvasWith(fakeContext()))).not.toBeNull()
  })

  it('一张素材这次解码失败:不记成「永远失败」,下次再要就再试', async () => {
    let decodes = 0
    vi.stubGlobal('Image', class {
      src = ''
      decode() {
        decodes += 1
        return decodes === 1 ? Promise.reject(new Error('decode failed')) : Promise.resolve()
      }
    })
    vi.stubGlobal('createImageBitmap', async () => ({ width: 4, height: 4, close() {} }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const gl = GuguGL.on(canvasWith(fakeContext()))!

    expect(await gl.loadTexture('body', 'body.webp', { w: 4, h: 4 })).toBe(false)
    expect(gl.has('body')).toBe(false)
    expect(await gl.loadTexture('body', 'body.webp', { w: 4, h: 4 })).toBe(true)
    expect(gl.has('body')).toBe(true)
    expect(decodes).toBe(2)
  })

  it('一批里每一趟占一格,从左往右排、排满换行;排不下且已有格子 = 先抄走再来;空着时不够就放大画布', () => {
    const canvas = canvasWith(fakeContext())
    canvas.width = 512
    canvas.height = 512
    const gl = GuguGL.on(canvas)!
    expect(gl.room(64, 64, 2)).toBe(true)
    expect(gl.begin(64, 64)).toEqual([0, 0])
    expect(gl.begin(64, 64)).toEqual([64, 0])
    for (let i = 2; i < 8; i++) gl.begin(64, 64)
    expect(gl.begin(64, 64), '一行 8 格排满:换到下一行').toEqual([0, 64])
    expect(gl.room(400, 400, 2), '已经有格子,大头像两趟放不下:false,❌ 放大画布把画好的清掉').toBe(false)
    expect(canvas.width).toBe(512)
    gl.reset()
    expect(gl.room(400, 400, 2), '空着:放大画布装下').toBe(true)
    expect(canvas.width).toBe(800)
    expect(gl.begin(400, 400)).toEqual([0, 0])
    expect(gl.begin(400, 400)).toEqual([400, 0])
    expect(() => gl.begin(400, 400), '没问 room() 就硬排:报错,❌ 画到画布外面去').toThrow(/room\(\)/)
  })

  it('本体和它的部件拼在一张图集里:一格里的几片攒成一次绘制;换了纹理才另画一次', async () => {
    vi.stubGlobal('Image', class {
      src = ''
      decode() {
        return Promise.resolve()
      }
    })
    vi.stubGlobal('createImageBitmap', async () => ({ width: 8, height: 8, close() {} }))
    const draws: [unknown, number][] = []
    const gl = GuguGL.on(canvasWith(fakeContext(false, draws)))!
    const px = { w: 8, h: 8 }
    expect(await gl.loadAtlas([{ id: 'body', url: 'b', size: px }, { id: 'wing', url: 'w', size: px }, { id: 'beak', url: 'k', size: px }])).toBe(true)
    expect(await gl.loadTexture('hat', 'h', px)).toBe(true)
    expect(gl.has('wing')).toBe(true)

    gl.begin(64, 64)
    gl.drawSprite('wing', 0, 1, 1, null, 1, 1)
    gl.drawSprite('body', 0, 1, 1)
    gl.drawSprite('beak', 0, 1, 0.5, null, 1, 1)
    expect(draws, '攒着,还没画').toHaveLength(0)
    gl.drawSprite('hat', 0, 1, 1)
    expect(draws, '换了纹理:前面三片一次画掉').toHaveLength(1)
    expect(draws[0][1]).toBe(14 * 28 * 6 + 2 * 6)
    gl.flush()
    expect(draws).toHaveLength(2)
    gl.flush()
    expect(draws, '没攒着的就不画').toHaveLength(2)
  })

  it('肩部覆盖使用网格顶点的不透明度,普通素材保持原有不透明度', async () => {
    vi.stubGlobal('Image', class { src = ''; decode() { return Promise.resolve() } })
    vi.stubGlobal('createImageBitmap', async () => ({ width: 8, height: 8, close() {} }))
    const uploaded: Float32Array[] = []
    const context = new Proxy(fakeContext(), {
      get(target, key) {
        if (key === 'bufferData') return (_target: number, data: unknown) => {
          if (data instanceof Float32Array) uploaded.push(data.slice())
        }
        return Reflect.get(target, key)
      },
    })
    const gl = GuguGL.on(canvasWith(context))!
    await gl.loadTexture('body', 'body.webp', { w: 8, h: 8 })
    gl.begin(64, 64)
    gl.drawSprite('body', 0, 1, 0.8, null, 1, 1)
    gl.drawSprite('body', 0, 1, 0.8, null, 1, 1, new Float32Array([0, 0.25, 0.5, 1]))
    gl.flush()
    expect(uploaded).toHaveLength(1)
    const opacity = Array.from(uploaded[0]).filter((_, i) => i % 6 === 4)
    expect(opacity.map((a) => Math.round(a * 100))).toEqual([80, 80, 80, 80, 0, 20, 40, 80])
  })
})
