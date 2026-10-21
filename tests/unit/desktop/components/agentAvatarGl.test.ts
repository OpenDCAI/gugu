// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GuguGL } from '../../../../apps/desktop/src/components/agentAvatar/engine/gl'

/** 一个什么都不做、什么都答「成了」的 WebGL2 上下文:只为让建管线、载图那几步走得通 */
function fakeContext(lost = false): WebGL2RenderingContext {
  return new Proxy({} as Record<string | symbol, unknown>, {
    get(_target, prop) {
      if (prop === 'isContextLost') return () => lost
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
})
