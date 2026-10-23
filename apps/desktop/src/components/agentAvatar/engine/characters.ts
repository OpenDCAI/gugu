/**
 * characters.ts —— 角色包：一个角色 = 一张无眼素材 + 刚体部件（翅膀 / 喙 / 脚，rig.ts）+ 实测几何 + 眼睛球面 + 各状态形态的素材包（forms）。
 * 动效引擎（engine.ts）、变形（geometry.ts）、渲染（draw.ts / gl.ts）都不含任何角色常数，换角色只换这里。
 *
 * 当前只有定稿主体 fjj-beak（fjj 的小鸟，有小嘴；owner 2026-10-12 定）。
 */
import { FJJ_PACKS } from './packs'
import type { Rig } from './rig'
import bodyUrl from '../assets/fjj-beak-body.webp'
import flatUrl from '../assets/fjj-beak-flat.webp'
import wingL from '../assets/parts/wing-l.webp'
import wingR from '../assets/parts/wing-r.webp'
import wingLShade from '../assets/parts/wing-l-ao.webp'
import wingRShade from '../assets/parts/wing-r-ao.webp'
import beak from '../assets/parts/beak.webp'
import footL from '../assets/parts/foot-l.webp'
import footR from '../assets/parts/foot-r.webp'
import footLShade from '../assets/parts/foot-l-ao.webp'
import footRShade from '../assets/parts/foot-r-ao.webp'

export type CharacterId = 'fjj-beak'

/**
 * 一个形态素材包：一张无眼素材 + 落地点 + 眼睛球面。Character 本身也满足这个形状（本体就是一种形态）。
 * 素材坐标 = 各自 png 的像素，原点左上；落地点 pivot = 轮廓最低处中心。
 */
export interface Pack {
  id: string
  sprite: string
  spr: { w: number; h: number }
  pivot: { x: number; y: number }
  neck: { x: number; y: number }
  headBand: [number, number]
  chest: { y: number; s: number }
  lift: number
  rollGain: number
  lookGain: number
  head: { x: number; y: number; r: number }
  eye: Character['eye']
  shadow: { rx: number; ry: number }
  rig?: Rig
}

/** 形态 → 素材：三颗点=faceball(长眼睛的球)+plain(素球)，「!」=stem(棒)+plain 当点，出错=faceball→dome，不在线/已移除=sleep，确认中=roll。
 *  变形时只留眼睛：手（翅膀）、脚、嘴都不带（owner 10-12），所以有嘴/无嘴两版变形后长得一样 */
export interface FormPacks {
  faceball: Pack
  stem: Pack
  dome: Pack
  sleep: Pack
  roll: Pack
  plain: Pack
}

export interface Character {
  id: CharacterId
  zh: string
  sprite: string // 素材的 URL（构建时由 vite 给出）：身体底图（翅膀、喙、脚在 rig 里）
  flat: string // 没有 WebGL 时整张贴的定格图：身体 + 各部件在静止位置拼好的一张
  spr: { w: number; h: number }
  pivot: { x: number; y: number } // 站在地上的支点（脚底中心）：挤压/倾斜都绕它
  neck: { x: number; y: number } // 头部翻滚（歪头）的转轴
  headBand: [number, number] // 头部「刚」的纵向范围：y<a 全跟头走，y>b 不跟
  chest: { y: number; s: number } // 呼吸时鼓起的位置与宽度
  lift: number // 倾斜的归一化高度（≈ 身高）
  rollGain: number // 歪头角度的折算
  lookGain: number // 光标引起的视线偏转的折算（球面大、眼睛靠边会变形的角色要收一点）
  head: { x: number; y: number; r: number } // 「自己」那一团：眼睛球面的圆心与半径
  eye: {
    rs: number
    yaw0: number
    pitch0: number
    roll0: number
    split: number
    r: number // 眼睛基础半径（宽度方向，素材像素）
    aspect: number // 高/宽：A 是圆眼 1，fjj 是竖椭圆
    gloss: { x: number; y: number; r: number } // 主高光：x 以眼宽、y 以眼高为单位，r 以眼宽为单位
    socket: number // 豆眼窝暗影的浓度
  }
  view: { ref: number; top: number; bottom: number; cx: number; bustFill: number }
  shadow: { x: number; rx: number; ry: number }
  backdrop: [string, string, string]
  rig?: Rig // 翅膀、喙、脚（rig.ts）；没有 = 形态素材，只有一团
  forms?: FormPacks // 各展示状态的「形态」素材（第 7 轮设计稿出图抠出）；没有 = 只换表情，身体不变形
}

const FJJ_BACKDROP: [string, string, string] = [
  'rgb(184,232,206)',
  'rgb(160,218,188)',
  'rgb(138,203,170)'
]
const FJJ_FORMS: FormPacks = {
  faceball: FJJ_PACKS['fjj-faceball'],
  stem: FJJ_PACKS['fjj-stem'],
  dome: FJJ_PACKS['fjj-dome'],
  sleep: FJJ_PACKS['fjj-sleep'],
  roll: FJJ_PACKS['fjj-roll'],
  plain: FJJ_PACKS['fjj-plain']
}

// ───────────── fjj 版（有小嘴）：身体与部件由 S 素材拆出（设计稿第 2 轮），坐标对齐原 1000×942 画幅，数值全是实测 ─────────────
/** 身体底图每 10 个素材像素一行的半宽（逐行量出）：转圈时部件绕的横截面 */
const FJJ_HALFW = [
  0, 0, 0, 39.5, 88, 115.5, 139.5, 159, 174.5, 190, 201, 213.5, 223.5, 233.5, 243.5, 250.5, 259, 265, 271.5, 278, 283, 287.5, 293, 298,
  302, 306, 309, 313.5, 316, 320, 322.5, 325, 328, 330.5, 333.5, 336.5, 339, 342, 345, 348.5, 351.5, 354, 358, 361, 364, 367.5, 370.5,
  374, 377, 380, 383, 385.5, 388.5, 390.5, 392.5, 394.5, 396.5, 398, 399.5, 400.5, 401.5, 402.5, 402.5, 402.5, 402, 400.5, 399.5, 398,
  396.5, 394.5, 392, 389, 385, 380, 375, 368.5, 361.5, 354, 344.5, 334.5, 323, 308.5, 291.5, 271, 246.5, 212, 153.5, 0, 0, 0, 0, 0, 0, 0, 0
]
const FJJ_RIG: Rig = {
  cx: 499.5,
  halfw: FJJ_HALFW,
  // 由下到上的画序在 draw.ts 里按深度排；这里的次序只决定同深度时谁先画
  pieces: [
    { id: 'fjj-part-foot-l', sprite: footL, kind: 'foot', side: -1, box: { x: 232, y: 823, w: 199, h: 98 }, at: { x: 323.7, y: 874.4 }, shade: { id: 'fjj-part-foot-l-ao', sprite: footLShade, box: { x: 229, y: 800, w: 227, h: 73 } } },
    { id: 'fjj-part-foot-r', sprite: footR, kind: 'foot', side: 1, box: { x: 564, y: 825, w: 202, h: 99 }, at: { x: 671.0, y: 877.7 }, shade: { id: 'fjj-part-foot-r-ao', sprite: footRShade, box: { x: 539, y: 803, w: 235, h: 71 } } },
    { id: 'fjj-part-beak', sprite: beak, kind: 'beak', side: 0, box: { x: 439, y: 366, w: 181, h: 155 }, at: { x: 536.1, y: 444.6 } },
    // 肩轴靠近翅根上端:抬翅时根部留在体侧,不让上端绕翅膀中段扫进胸口。
    { id: 'fjj-part-wing-l', sprite: wingL, kind: 'wing', side: -1, rootFeather: 14, box: { x: 10, y: 403, w: 175, h: 291 }, at: { x: 168, y: 425 }, grip: { x: 65.7, y: 575.9 }, shade: { id: 'fjj-part-wing-l-ao', sprite: wingLShade, box: { x: 101, y: 386, w: 103, h: 319 } } },
    { id: 'fjj-part-wing-r', sprite: wingR, kind: 'wing', side: 1, rootFeather: 14, box: { x: 819, y: 419, w: 168, h: 282 }, at: { x: 836, y: 441 }, grip: { x: 930.6, y: 591.3 }, shade: { id: 'fjj-part-wing-r-ao', sprite: wingRShade, box: { x: 805, y: 411, w: 99, h: 301 } } }
  ]
}

const FJJ_BEAK: Character = (() => {
  const cx = 507.2,
    yh = 335.5,
    rh = 310.4
  const feet = 913.4
  const top = 26
  const ref = feet - top + 26
  return {
    id: 'fjj-beak',
    zh: '有小嘴',
    sprite: bodyUrl,
    flat: flatUrl,
    spr: { w: 1000, h: 942 },
    pivot: { x: cx, y: feet - 2 },
    neck: { x: cx, y: 520 },
    headBand: [300, 720],
    chest: { y: 560, s: 260 },
    lift: 857.0,
    rollGain: 0.7,
    lookGain: 0.6,
    head: { x: cx, y: yh, r: rh },
    eye: {
      rs: 290.6,
      yaw0: 8.78,
      pitch0: 5.16,
      roll0: -0.16,
      split: 28.51,
      r: 70.0,
      aspect: 1.154,
      gloss: { x: -0.3, y: -0.5, r: 0.15 },
      socket: 0.5
    },
    view: { ref, top, bottom: feet + 3, cx, bustFill: 1.0 },
    shadow: { x: cx, rx: 275, ry: 40 },
    backdrop: FJJ_BACKDROP,
    forms: FJJ_FORMS,
    rig: FJJ_RIG
  }
})()

export const CHARACTER_BY_ID: Record<CharacterId, Character> = { 'fjj-beak': FJJ_BEAK }
export const DEFAULT_CHARACTER: CharacterId = 'fjj-beak'
