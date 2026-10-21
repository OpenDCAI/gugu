/**
 * characters.ts —— 角色包：一个角色 = 一张无眼素材 + 实测几何 + 眼睛球面 + 各状态形态的素材包（forms）。
 * 动效引擎（engine.ts）、变形（geometry.ts）、渲染（draw.ts / gl.ts）都不含任何角色常数，换角色只换这里。
 *
 * 当前只有定稿主体 fjj-beak（fjj 的小鸟，有小嘴；owner 2026-10-12 定）。
 */
import { FJJ_PACKS } from './packs'
import bodyUrl from '../assets/fjj-beak-body.webp'

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
  face?: Character['face']
  wings?: Character['wings']
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

export interface WingGeo {
  x: number
  y: number
  rx: number
  ry: number
  rootX: number
  rootY: number
}

export interface Character {
  id: CharacterId
  zh: string
  sprite: string // 素材的 URL（构建时由 vite 给出）
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
  face?: { x: number; y: number; R: number } // 脸区（小嘴）：随视线一起滑
  wings?: { l: WingGeo; r: WingGeo }
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

// ───────────── fjj 版（有小嘴）：由 流水线/素材化/build_fjj.py 从 B3 抠出，数值全是实测 ─────────────
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
    wings: {
      l: { x: 89.3, y: 542.1, rx: 72.5, ry: 142.0, rootX: 129.2, rootY: 492.4 },
      r: { x: 904.5, y: 564.7, rx: 64.5, ry: 124.4, rootX: 869.0, rootY: 521.2 }
    },
    face: { x: 543.8, y: 443.8, R: 200 }
  }
})()

export const CHARACTER_BY_ID: Record<CharacterId, Character> = { 'fjj-beak': FJJ_BEAK }
export const DEFAULT_CHARACTER: CharacterId = 'fjj-beak'
