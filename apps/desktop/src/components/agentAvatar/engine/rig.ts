/**
 * rig.ts —— 本体上的刚体部件:两只翅膀、喙、两只脚各是一张素材,不烘在身体那张图里。
 *
 * 为什么拆开:翅膀烘在身体图里时,「抬翅」只能靠软网格把翅根附近的身体一起扭过去;拆开以后翅膀绕肩转,
 * 身体不动。原地转一圈(开心)也只有拆开才做得出来:身体是绕竖轴转不出差别的梨形,转的是长在它上面的东西。
 *
 * 一个部件跟身体的关系只有一句话:部件素材上的点 q 画在 W(A) + J·M·(q − A) 处。
 *  · A 是部件的挂点(翅膀 = 肩上的铰点,喙和脚 = 中心),W 是身体的软网格变形(draw.ts place),J 是 W 在 A 处的雅可比
 *    —— 身体怎么挤、怎么歪、怎么蹦,挂点就怎么跟,部件本身不被扭。
 *  · M 是部件自己的动作:翅膀抬起的转角、转圈时的前缩(横向缩放,过了正面翻到另一侧)。
 *  · 转圈:每个部件在自己那一高度的身体横截面上有个角度 φ0 = asin((x − cx) / R(y)),转 yaw 度后在 cx + R·sin(φ0 + yaw),
 *    深度 cos(φ0 + yaw) < 0 就画在身体后面。翅膀、喙、脚、眼睛用同一个 yaw;yaw = 0 时位移恰好为 0。
 * 接触阴影(翅膀压在身上、脚底)是各自单独的一层,跟着部件走,部件离开原位就淡掉。
 */
import { DEG, clamp } from './geometry'

export type PieceKind = 'wing' | 'beak' | 'foot'

export interface RigPiece {
  /** GL 纹理 id */
  id: string
  sprite: string
  kind: PieceKind
  /** -1 = 观者左边那只,1 = 右边,0 = 中间 */
  side: -1 | 0 | 1
  /** Body-facing alpha transition, in source pixels; baked once when the texture loads. */
  rootFeather?: number
  /** 素材在本体坐标里的位置与大小 */
  box: { x: number; y: number; w: number; h: number }
  /** 挂点(本体坐标):翅膀的肩铰点在身体轮廓以内,所以怎么转翅根都压在身上 */
  at: { x: number; y: number }
  /** 翅膀:手里拿的装扮(伞、魔杖)握在哪(本体坐标) */
  grip?: { x: number; y: number }
  /** 压在身上的接触阴影(本体坐标) */
  shade?: { id: string; sprite: string; box: { x: number; y: number; w: number; h: number }; blur?: number }
}

export interface Rig {
  pieces: RigPiece[]
  /** 身体的竖轴(本体 x) */
  cx: number
  /** 身体每 10 个素材像素一行的半宽(从身体底图逐行量出):转圈时部件绕的横截面半径 */
  halfw: readonly number[]
}

/** 翅膀位置 1 个单位 = 这么多度(BodyParams.wl / wr) */
export const WING_DEG = 35.5

export function halfWidth(rig: Rig, y: number): number {
  const i = clamp(Math.floor(y / 10), 0, rig.halfw.length - 2)
  const t = clamp((y - i * 10) / 10)
  return rig.halfw[i] + (rig.halfw[i + 1] - rig.halfw[i]) * t
}

export interface PiecePose {
  /** 部件自己的 2×2 动作矩阵(本体坐标,y 向下) */
  m: [number, number, number, number]
  /** 挂点的平移(转圈;喙随视线滑) */
  dx: number
  dy: number
  /** > 0 在身体前面 */
  depth: number
  alpha: number
  /** 接触阴影的浓度 */
  shade: number
}

/** 部件这一帧的动作。wl / wr = 翅膀位置(单位见 WING_DEG),yaw = 转圈角度(度),fx / fy = 脸区随视线滑的位移 */
export function piecePose(rig: Rig, pc: RigPiece, b: { wl: number; wr: number; yaw: number; fx: number; fy: number }, out: PiecePose): PiecePose {
  let sx = 1
  let rot = 0
  let dx = 0
  let dy = 0
  let depth = 1
  let alpha = 1
  let shade = 1
  // 部件在本体横截面上的角度;yaw = 0 时下面这些都是恒等
  const R = pc.kind === 'foot' ? Math.max(halfWidth(rig, 830), Math.abs(pc.at.x - rig.cx) + 30) : halfWidth(rig, pc.at.y) - (pc.kind === 'wing' ? 12 : 0)
  const phi0 = Math.asin(clamp((pc.at.x - rig.cx) / R, -0.999, 0.999))
  const phi = phi0 + b.yaw * DEG
  if (b.yaw !== 0) {
    dx = rig.cx + R * Math.sin(phi) - pc.at.x
    depth = Math.cos(phi)
  }
  if (pc.kind === 'wing') {
    // 翅膀是绕肩转的一片:转圈时向外伸的长度随 sin φ 变,过了正面翻到另一侧;毛绒翅膀有厚度,最窄也留 32%。
    // 越接近正对 / 背对镜头,抬起的角度越小(不从头顶竖出去)
    const raw = b.yaw !== 0 ? Math.sin(phi) / Math.sin(phi0) : 1
    sx = Math.sign(raw || 1) * Math.max(0.32, Math.abs(raw))
    alpha = clamp((Math.abs(raw) - 0.06) / 0.2) // 翻面那一下(正对 / 背对镜头)先淡掉再出来,❌ 一帧里左右跳
    const lift = (pc.side < 0 ? b.wl : b.wr) * WING_DEG * (b.yaw !== 0 ? 0.35 + 0.65 * Math.abs(Math.sin(phi)) : 1)
    rot = -pc.side * lift
    // 素材已有内侧明暗,接触影只轻压一层,避免在身体上叠出深色描线。
    shade = 0.45 * clamp(1 - Math.abs(lift) / 18) * (depth > 0 ? 1 : 0)
  } else if (pc.kind === 'beak') {
    // 喙是头上的一个小包:跟着视线在球面上滑,转开时前缩、转到背面前淡出
    dx += b.fx
    dy += b.fy
    sx = Math.max(0.05, Math.cos(phi) / Math.cos(phi0))
    alpha = clamp(depth / 0.25)
  } else {
    // 毛绒的脚是一团,不是一张纸:只前缩一部分;脚底的接触阴影离开原位就淡掉
    sx = 0.55 + (0.45 * Math.abs(Math.cos(phi))) / Math.cos(phi0)
    shade = Math.max(0, Math.cos(phi - phi0)) ** 6
  }
  const c = Math.cos(rot * DEG),
    s = Math.sin(rot * DEG)
  out.m[0] = c * sx
  out.m[1] = -s * sx
  out.m[2] = s
  out.m[3] = c
  out.dx = dx
  out.dy = dy
  out.depth = depth
  out.alpha = alpha
  out.shade = shade
  return out
}

export const newPose = (): PiecePose => ({ m: [1, 0, 0, 1], dx: 0, dy: 0, depth: 1, alpha: 1, shade: 1 })

/** The body covers the lifted root; its original texture and mesh keep the shoulder continuous. */
export function shoulderCover(pc: RigPiece, ps: PiecePose, lift: number, x: number, y: number): number {
  if (pc.kind !== 'wing' || ps.depth < 0) return 0
  const raised = clamp(lift * 4)
  const horizontal = clamp((pc.box.w - Math.abs(x - pc.at.x - ps.dx)) / (pc.box.w * 0.25))
  const vertical = clamp((pc.box.h * 0.8 - Math.abs(y - pc.at.y - pc.box.h * 0.25)) / (pc.box.h * 0.2))
  return raised * raised * (3 - 2 * raised) * ps.alpha * horizontal * vertical
}

/** 一只翅膀的铰点与握点。没有翅膀的 rig 是角色包写错了:当场报 */
export function wingOf(rig: Rig, side: -1 | 1): { piece: RigPiece; at: { x: number; y: number }; grip: { x: number; y: number } } {
  for (const piece of rig.pieces) if (piece.kind === 'wing' && piece.side === side && piece.grip) return { piece, at: piece.at, grip: piece.grip }
  throw new Error(`rig has no ${side < 0 ? 'left' : 'right'} wing with a grip`)
}

const scratch = newPose()
/** 骑在翅膀上的一点(本体坐标):经这只翅膀的刚体动作后落在本体坐标哪里(还没过身体软网格)。手里拿的装扮跟着它走 */
export function onWing(rig: Rig, side: -1 | 1, b: { wl: number; wr: number; yaw: number; fx: number; fy: number }, x: number, y: number, out: [number, number]) {
  const pc = wingOf(rig, side).piece
  const ps = piecePose(rig, pc, b, scratch)
  const qx = x - pc.at.x,
    qy = y - pc.at.y
  out[0] = pc.at.x + ps.m[0] * qx + ps.m[1] * qy + ps.dx
  out[1] = pc.at.y + ps.m[2] * qx + ps.m[3] * qy + ps.dy
}
