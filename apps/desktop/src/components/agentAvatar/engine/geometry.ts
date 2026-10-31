/**
 * geometry.ts —— 软网格变形与眼睛球面投影（纯函数）。
 * 角色相关的常数（支点、脖子、头的圆、眼睛球面…）不在这里，在 characters.ts 的角色包 / 形态素材包（Pack）里；
 * 单位：素材像素，原点左上。
 */
import type { Pack } from './characters'

export const DEG = Math.PI / 180
export const TWO_PI = Math.PI * 2
export const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v))
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/** 球面眼睛投影（沿用 Mochi 引擎的做法）：三个角 → 屏幕位置 + 局部坐标轴（含透视压扁）+ 深度 */
export function projectEye(yawDeg: number, pitchDeg: number, rollDeg: number, anchorDeg: number) {
  const Y = (yawDeg + anchorDeg) * DEG
  const P = pitchDeg * DEG
  const R = rollDeg * DEG
  const cy = Math.cos(Y),
    sy = Math.sin(Y)
  const cp = Math.cos(P),
    sp = Math.sin(P)
  const cr = Math.cos(R),
    sr = Math.sin(R)
  const rot = (x: number, y: number, z: number): [number, number, number] => {
    const x1 = x * cy + z * sy
    const z1 = -x * sy + z * cy
    const y2 = y * cp + z1 * sp
    const z2 = -y * sp + z1 * cp
    return [x1 * cr - y2 * sr, x1 * sr + y2 * cr, z2]
  }
  const [px, py, pz] = rot(0, 0, 1)
  const [ax, ay] = rot(1, 0, 0)
  const [bx, by] = rot(0, 1, 0)
  return { x: px, y: py, depth: pz, ax, ay, bx, by }
}

// ───────────── 身体变形 ─────────────
export interface BodyParams {
  sx: number // 横向缩放（绕支点）
  sy: number // 纵向缩放（绕支点）= 挤压/拉伸
  lean: number // 头顶相对脚的横向位移（素材像素），越高位移越多
  roll: number // 头绕脖子歪的角度（度，正=顺时针）
  turn: number // 头相对身体左右平移（素材像素）
  nod: number // 头相对身体上下平移（正=向下）
  puff: number // 胸口横向鼓起比例
  hop: number // 离地高度（素材像素）
  wob: number // 果冻波幅度（素材像素）
  wobPhase: number // 果冻波相位
  fx: number // 喙随视线在球面上滑的位移（素材像素；rig.ts 的喙用，身体网格不滑）
  fy: number
  wl: number // 翅膀：-1 垂下 … 0 收着 … +1 高举（1 = rig.ts WING_DEG 度；翅膀是刚体部件，不扭身体网格）
  wr: number
  yaw: number // 绕身体竖轴转的角度（度）：部件和眼睛转，身体底图不变（rig.ts）
}

export const NEUTRAL_BODY: BodyParams = {
  sx: 1,
  sy: 1,
  lean: 0,
  roll: 0,
  turn: 0,
  nod: 0,
  puff: 0,
  hop: 0,
  wob: 0,
  wobPhase: 0,
  fx: 0,
  fy: 0,
  wl: 0,
  wr: 0,
  yaw: 0
}

/** 把素材里一点 (x,y) 送到变形后的位置。网格顶点、眼睛、腮红、刚体部件的挂点、特效锚点都走这一个函数，所以永远贴在身上 */
export function warp(x: number, y: number, b: BodyParams, out: [number, number], ch: Pack): void {
  const { pivot: P, neck: N } = ch
  let X = x
  let Y = y
  // 1) 头部：越靠近头顶越"刚"，脖子到肩的过渡区被柔和地扭过去，像绒毛玩偶
  const w = 1 - smoothstep(ch.headBand[0], ch.headBand[1], y)
  if (w > 0) {
    const ang = b.roll * DEG * w * ch.rollGain
    const dx = X - N.x
    const dy = Y - N.y
    const c = Math.cos(ang)
    const s = Math.sin(ang)
    X = N.x + dx * c - dy * s + b.turn * w
    Y = N.y + dx * s + dy * c + b.nod * w
  }
  // 2) 胸口鼓起（呼吸）
  const bump = Math.exp(-(((y - ch.chest.y) / ch.chest.s) ** 2))
  X = P.x + (X - P.x) * (1 + b.puff * bump)
  // 3) 挤压拉伸：绕脚底
  X = P.x + (X - P.x) * b.sx
  Y = P.y + (Y - P.y) * b.sy
  // 4) 倾斜 + 果冻波：离脚越高位移越大，脚底不动
  const h = clamp((P.y - y) / ch.lift, 0, 1.2)
  X += b.lean * Math.pow(h, 1.5) + b.wob * Math.sin(5.5 * h - b.wobPhase) * h
  // 5) 跳起
  Y -= b.hop
  out[0] = X
  out[1] = Y
}
