import { describe, expect, it } from 'vitest'
import { drawEye, drawnLook, lookDiff } from '../../../../apps/desktop/src/components/agentAvatar/engine/draw'
import { GuguEngine } from '../../../../apps/desktop/src/components/agentAvatar/engine/engine'
import type { EyeOut } from '../../../../apps/desktop/src/components/agentAvatar/engine/engine'

// 用户反馈「眼珠太黑、不可爱」(#7160):小尺寸里眼睛曾经连高光都没有(读成黑洞)。这里把眼睛画到一块只记账的假画布上,
// 看 drawEye 在「小尺寸」下是否仍画出主 / 次两个高光,且大小不低于下限。

/** 记下每次 arc(...) 的半径与当时的 fillStyle;其余画布方法一律吞掉。 */
function recordingCtx(devPerUnit: number) {
  const arcs: { r: number }[] = []
  const gradient = { addColorStop() {} }
  const target: Record<string, unknown> = {
    fillStyle: '',
    globalAlpha: 1,
    arc: (_x: number, _y: number, r: number) => arcs.push({ r }),
    getTransform: () => ({ a: devPerUnit, b: 0, c: 0, d: devPerUnit }),
    createRadialGradient: () => gradient,
  }
  const ctx = new Proxy(target, {
    get: (t, k: string) => (k in t ? t[k] : () => undefined),
    set: (t, k: string, v) => ((t[k] = v), true),
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, arcs }
}

const eye = (r: number): EyeOut =>
  ({
    cx: 0, cy: 0, ax: 1, ay: 0, bx: 0, by: 1, r, alpha: 1, aspect: 1.2, inner: 0, gx: 0, gy: 0, blush: 0,
    shape: { size: 1, tOff: -1, tSlope: 0, tBow: 0, bOff: 1, bSlope: 0, bBow: 0 },
  }) as unknown as EyeOut
const GLOSS = { x: -0.3, y: -0.5, r: 0.15 }

describe('眼睛的高光', () => {
  it('小尺寸(small=true)也画主 + 次两个高光', () => {
    const { ctx, arcs } = recordingCtx(1)
    drawEye(ctx, eye(10), true, GLOSS, 0.5)
    expect(arcs.length, '小尺寸里没有高光 = 回到「黑洞」').toBe(2)
  })

  it('小头像里高光半径不低于 2.4 设备像素(眼睛本身只有几个像素时它也看得见)', () => {
    const devPerUnit = 0.5 // 1 个眼睛单位 = 0.5 设备像素:眼睛半径 6 单位 = 3 像素
    const { ctx, arcs } = recordingCtx(devPerUnit)
    drawEye(ctx, eye(6), true, GLOSS, 0.5)
    const main = arcs[0].r * devPerUnit
    expect(main).toBeGreaterThanOrEqual(2.4 - 1e-6)
  })

  it('大尺寸的主高光比原来(0.15 眼宽)大', () => {
    const { ctx, arcs } = recordingCtx(4)
    drawEye(ctx, eye(40), false, GLOSS, 0.5)
    const main = arcs[arcs.length - 2].r
    expect(main).toBeGreaterThan(0.15 * 40 * 0.96)
  })

  it('睁得不够开(几乎闭上)或透明度太低时不画', () => {
    const { ctx, arcs } = recordingCtx(1)
    drawEye(ctx, { ...eye(10), alpha: 0.01 }, true, GLOSS, 0.5)
    expect(arcs).toHaveLength(0)
  })
})

describe('drawnLook:这一帧画出来是什么样(runtime 据此只画会变的帧)', () => {
  // 40px 头像在 2 倍屏上:80 个画布像素
  const o = { w: 80, h: 80, dpr: 2, shape: 'free' as const, bg: false, crop: 'full' as const, fx: false }
  const lookOf = (engine: GuguEngine) => [...drawnLook(engine.frame, o, [])]
  // runtime 的「同一张」:差不到半个 CSS 像素(2 倍屏上 1 个画布像素)
  const sameLook = (a: number[], b: number[]) => lookDiff(a, b) < 0.5 * o.dpr

  it('同一帧取两次是同一张;静着的小鸟 10 秒里要画的帧远少于 600,但不是 0(呼吸、视线、眨眼照样在动)', () => {
    const engine = new GuguEngine(7)
    engine.update(1 / 60, null)
    let drawn = lookOf(engine)
    expect(sameLook(drawn, lookOf(engine))).toBe(true)
    let draws = 0
    for (let i = 0; i < 600; i++) {
      engine.update(1 / 60, null)
      const now = lookOf(engine)
      if (!sameLook(drawn, now)) {
        draws++
        drawn = now
      }
    }
    // 80 个画布像素的头像 10 秒里只有几十帧算变了(原来 600 帧帧都画)
    expect(draws).toBeGreaterThan(10)
    expect(draws).toBeLessThan(200)
  })

  it('部件挪动小于半个 CSS 像素不算变;挪过一个多 CSS 像素就算变(判据两头都会翻)', () => {
    const engine = new GuguEngine(7)
    engine.update(1 / 60, null)
    const a = lookOf(engine)
    const part = engine.frame.layers[engine.frame.layers.length - 1].parts.list[0]
    part.gx += 2 // 素材像素:80px 画布上约 0.14 个画布像素
    expect(sameLook(a, lookOf(engine))).toBe(true)
    part.gx += 18 // 共 20 素材像素 ≈ 1.4 个画布像素
    expect(sameLook(a, lookOf(engine))).toBe(false)
  })
})
