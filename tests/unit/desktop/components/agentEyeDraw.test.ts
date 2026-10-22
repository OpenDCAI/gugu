import { describe, expect, it } from 'vitest'
import { drawnLook, lookDiff } from '../../../../apps/desktop/src/components/agentAvatar/engine/draw'
import { blinkCurve, blinkEye, drawEye } from '../../../../apps/desktop/src/components/agentAvatar/engine/face'
import { GuguEngine } from '../../../../apps/desktop/src/components/agentAvatar/engine/engine'
import { EXPRESSION_BY_ID, OPEN_EYE as OPEN, type EyeShape } from '../../../../apps/desktop/src/components/agentAvatar/engine/spec'

// 用户反馈「眼珠太黑、不可爱」(#7160):小尺寸里眼睛曾经连高光都没有(读成黑洞)。这里把眼睛画到一块只记账的假画布上,
// 看 drawEye 在「小尺寸」下是否仍画出高光;又不能大过豆子的一半(32px 的眼睛只有两三个像素,高光一大就成了白圈)。

/** 记下每次 arc(...) 的半径;其余画布方法一律吞掉。devPerUnit = 一个局部单位多少设备像素 */
function recordingCtx(devPerUnit: number) {
  const arcs: { r: number }[] = []
  const gradient = { addColorStop() {} }
  const target: Record<string, unknown> = {
    fillStyle: '',
    strokeStyle: '',
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

const GLOSS = { x: -0.3, y: -0.5, r: 0.15 }
const draw = (ctx: CanvasRenderingContext2D, r: number, small: boolean, alpha = 1, shape = OPEN) =>
  drawEye(ctx, shape, 1, r, 1.2, alpha, GLOSS, 0, 0, small, 0.5)

describe('眼睛的高光', () => {
  it('小尺寸(small=true)也画主高光', () => {
    const { ctx, arcs } = recordingCtx(1)
    draw(ctx, 10, true)
    expect(arcs.length, '小尺寸里没有高光 = 回到「黑洞」').toBeGreaterThanOrEqual(1)
  })

  it('小头像里高光至少 1.6 个设备像素,但不超过豆子的一半(❌ 32px 的眼睛被高光盖成白圈)', () => {
    const devPerUnit = 0.5 // 1 个眼睛单位 = 0.5 设备像素
    for (const r of [4, 6, 20]) {
      const { ctx, arcs } = recordingCtx(devPerUnit)
      draw(ctx, r, true)
      const main = arcs[0].r
      expect(main, `r=${r}`).toBeLessThanOrEqual(0.42 * r + 1e-6)
      expect(main * devPerUnit, `r=${r}`).toBeGreaterThanOrEqual(Math.min(1.6, 0.42 * r * devPerUnit) - 1e-6)
    }
  })

  it('大尺寸的主高光比原来(0.15 眼宽)大', () => {
    const { ctx, arcs } = recordingCtx(4)
    draw(ctx, 40, false)
    const main = arcs[arcs.length - 2].r
    expect(main).toBeGreaterThan(0.15 * 40)
  })

  it('透明度太低时不画', () => {
    const { ctx, arcs } = recordingCtx(1)
    draw(ctx, 10, true, 0.01)
    expect(arcs).toHaveLength(0)
  })
})

describe('眨眼:眼皮盖下来、真的合上、合着停一下', () => {
  // 两条眼皮在眼睛中线上的距离(眼高为单位):≤ 0 = 合上了
  const gap = (e: EyeShape) => e.bOff + e.bBow - (e.tOff + e.tBow)
  const out = { ...OPEN }

  // 合上 = 一道顺着眼球往下弯的 ‿(上眼皮中间往下垂、和下眼皮夹成一道细弯月),❌ 一条水平直线把豆子从上往下切掉
  const shut = (e: EyeShape) => {
    expect(gap(e)).toBeGreaterThan(0.1)
    expect(gap(e)).toBeLessThanOrEqual(0.3)
    expect(e.tBow).toBeGreaterThanOrEqual(0.25)
  }

  it('合到最紧时是一道弯弧 ‿(原来是一条看不见的直线切豆子,最深一帧只剩底下一条平顶的缝,读成眼睛一闪)', () => {
    shut(blinkEye(OPEN, 1, out))
  })

  it('半闭着的眼睛从它此刻的眼皮位置接着合,同样合上(原来写死的目标让得意脸眨眼时碎成细片)', () => {
    for (const id of ['sleepy', 'attentive', 'suspicious', 'sad'] as const) {
      const ex = EXPRESSION_BY_ID[id]
      for (const e of [ex.L, ex.R]) {
        const half = blinkEye(e, 0.5, { ...out })
        expect(half.tOff + half.tBow, `${id} 合到一半时上眼皮往下走了`).toBeGreaterThan(e.tOff + e.tBow - 1e-6)
        shut(blinkEye(e, 1, { ...out }))
      }
    }
  })

  it('时序:合 70ms → 合着停 40ms → 睁 150ms(合着的那几帧一定画得到)', () => {
    expect(blinkCurve(0)).toBe(0)
    expect(blinkCurve(0.07)).toBe(1)
    expect(blinkCurve(0.09)).toBe(1)
    expect(blinkCurve(0.11)).toBe(1)
    expect(blinkCurve(0.18)).toBeGreaterThan(0)
    expect(blinkCurve(0.18)).toBeLessThan(1)
    expect(blinkCurve(0.26)).toBe(0)
    // 先快后慢地睁开:睁开那段的前一半走完了一大半
    expect(blinkCurve(0.11 + 0.075)).toBeLessThan(0.2)
  })

  it('笑弧、平线、挤眼本来就闭着:不眨', () => {
    for (const k of ['arc', 'flat', 'chev'] as const) {
      const e = { ...OPEN, [k]: 1 }
      expect(blinkEye(e, 1, { ...out })).toEqual(e)
    }
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
