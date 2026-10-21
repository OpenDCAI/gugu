/**
 * outfitCatalog.ts —— 每件装扮的数据:几片素材 + 挂法 + 落位 + 各形态怎么办 + 配色 + 跨位置冲突。怎么画见 outfits.ts。
 * 坐标单位见 outfits.ts 的 Fit:head 以「长眼睛那个部件」的头圆(圆心、半径 r)为单位;本体头圆 = (507, 335.5, r 310)。
 * 素材是出图后抠的(2026-10-16 设计与出图),配色不另出图:同一张素材过一道 canvas filter。
 * id 写进形象地址(look.ts 的 wear),❌ 改名;要换就加新 id。
 */
import type { FormId } from './forms'

export type Pass = 'back' | 'mid' | 'top'
export type Slot = 'costume' | 'head' | 'face' | 'ears' | 'neck' | 'feet' | 'back' | 'hand'
export type Mount = 'head' | 'eyes' | 'ground' | 'wing' | 'hold'

/** 落位:head = 头圆单位(tu, tv 是锚点相对圆心的位置,w 是素材整宽占几个半径);eyes = tv 以两眼距为单位,w 是倍率;ground = w 是板宽占落地影宽的倍率 */
export interface Fit {
  tu: number
  tv: number
  w: number
  rot?: number // 度
}
export interface FormRule {
  hide?: boolean
  fit?: Partial<Fit>
}
export interface Sway {
  x: number
  y: number // 转轴(素材像素)
  ramp: number // 从转轴往下多远才全量跟甩(素材像素)
  x0?: number
  x1?: number // 只甩这段横向范围(素材像素),不给 = 整宽
  k: number // 增益
}
export interface Bob {
  x: number
  y: number
  r: number
  k: number
}
export interface Colorway {
  filter: string // canvas filter(hue-rotate / saturate / brightness),'none' = 原色
  swatch: string
}
/** 一片素材:一件装扮可以有几片(花环前后两半圈、披风领子和下摆、背包和背带),各自一个层次 */
export interface Piece {
  file: string // assets/outfits/ 下的文件名
  size: { w: number; h: number }
  anchor: { x: number; y: number }
  pass: Pass
  fit?: Fit // 不给 = 用整件的 fit(几片共用同一个坐标系时)
  mount?: Mount // 不给 = 整件的挂法
  wing?: 'l' | 'r' // hold:握在哪只翅膀尖(观者的左 / 右)
  only?: 'forms' | 'body' // forms = 只在变形后的团子上画(轻套装的头顶那截);body = 只在本体上画(项圈、尾巴、魔杖)
  lens?: [{ x: number; y: number }, { x: number; y: number }] // eyes:两片镜片中心(素材像素)
  sway?: Sway
  bob?: Bob
}
export interface OutfitDef {
  id: string
  slot: Slot
  mount: Mount
  z: number // 同一层里的先后(小的先画):背带 < 围巾、领结
  fit: Fit
  pieces: Piece[]
  forms?: Partial<Record<FormId, FormRule>>
  small?: number // 小尺寸(< 70 设备像素)里放大多少:细碎的(花环、蝴蝶结)放大才认得出
  conflicts?: string[] // 跨位置也不能同时戴的(id)
  colorways: Colorway[]
}

/** 形象里存的一件:装扮 id + 配色序号(look.ts 拼进 / 读出形象地址) */
export interface WearItem {
  id: string
  cw: number
}

// ───────────── 搭配:同一位置一件 + 跨位置的冲突表 ─────────────
/** 轻套装自带头箍 / 帽子、领口的小件、背后的尾巴或翅膀:和头上、耳朵、脖子、背后的单件打架;脸上、脚下、手里的照戴 */
const COSTUME_CLASH: Slot[] = ['head', 'ears', 'neck', 'back']
export function clashes(a: OutfitDef, b: OutfitDef): boolean {
  if (a === b) return false
  if (a.slot === b.slot) return true
  if ((a.slot === 'costume' && COSTUME_CLASH.includes(b.slot)) || (b.slot === 'costume' && COSTUME_CLASH.includes(a.slot))) return true
  return !!a.conflicts?.includes(b.id) || !!b.conflicts?.includes(a.id)
}

/** 同一身的稳定写法(比较用):按存的顺序 */
export function wearKey(wear: readonly WearItem[] | undefined): string {
  return wear ? wear.map((w) => `${w.id}.${w.cw}`).join(',') : ''
}

const cw = (...list: [string, string][]): Colorway[] => list.map(([filter, swatch]) => ({ filter, swatch }))

/** 变形后没有脖子 / 背 / 翅膀的形态：挂在那里的装扮一律收起 */
const NO_TORSO = {
  dots: { hide: true },
  bang: { hide: true },
  errorBall: { hide: true },
  errorDome: { hide: true },
  sleep: { hide: true },
  roll: { hide: true }
}

const HATS = ['beanie', 'crown', 'strawhat', 'tophat', 'partyhat', 'flowercrown', 'santahat', 'bow']

export const OUTFIT_DEFS: OutfitDef[] = [
  // ───────────── 轻套装（owner 10-17：整只包起来的套装太侵略，改成主题小件组合、鸟身露出来；10-19：套装也能换配色，一身各片同一道滤镜） ─────────────
  {
    id: 'set-puppy',
    slot: 'costume',
    mount: 'head',
    z: 4,
    fit: { tu: -1.5535, tv: -1.0615, w: 3.0026 },
    pieces: [
      { file: 'set-puppy-back.webp', size: { w: 932, h: 818 }, anchor: { x: 0, y: 0 }, pass: 'back', only: 'body' },
      { file: 'set-puppy-front.webp', size: { w: 932, h: 818 }, anchor: { x: 0, y: 0 }, pass: 'mid', only: 'body' },
      { file: 'set-puppy-head.webp', size: { w: 932, h: 818 }, anchor: { x: 0, y: 0 }, pass: 'mid', only: 'forms' }
    ],
    colorways: cw(['none', '#d23a3c'], ['hue-rotate(200deg) saturate(0.9)', '#3f78c8'], ['hue-rotate(100deg) saturate(0.8)', '#4f9a5a'])
  },
  {
    id: 'set-garfield',
    slot: 'costume',
    mount: 'head',
    z: 4,
    fit: { tu: -1.6372, tv: -1.0873, w: 2.6546 },
    pieces: [
      { file: 'set-garfield-back.webp', size: { w: 824, h: 858 }, anchor: { x: 0, y: 0 }, pass: 'back', only: 'body' },
      { file: 'set-garfield-front.webp', size: { w: 824, h: 858 }, anchor: { x: 0, y: 0 }, pass: 'mid', only: 'body' },
      { file: 'set-garfield-head.webp', size: { w: 824, h: 858 }, anchor: { x: 0, y: 0 }, pass: 'mid', only: 'forms' }
    ],
    colorways: cw(['none', '#e8903a'], ['saturate(0.15) brightness(1.05)', '#a8a29c'], ['hue-rotate(-25deg) saturate(0.6) brightness(0.75)', '#8a5a3c'])
  },
  {
    id: 'set-bear',
    slot: 'costume',
    mount: 'head',
    z: 4,
    fit: { tu: -1.4343, tv: -1.1099, w: 2.5129 },
    pieces: [
      { file: 'set-bear-back.webp', size: { w: 780, h: 829 }, anchor: { x: 0, y: 0 }, pass: 'back', only: 'body' },
      { file: 'set-bear-front.webp', size: { w: 780, h: 829 }, anchor: { x: 0, y: 0 }, pass: 'mid', only: 'body' },
      { file: 'set-bear-head.webp', size: { w: 780, h: 829 }, anchor: { x: 0, y: 0 }, pass: 'mid', only: 'forms' }
    ],
    colorways: cw(['none', '#9a6a44'], ['sepia(0.3) saturate(0.6) brightness(1.35)', '#d8b48a'], ['saturate(0) brightness(0.55)', '#4a4a4a'])
  },
  {
    id: 'set-dino',
    slot: 'costume',
    mount: 'head',
    z: 4,
    fit: { tu: -1.6211, tv: -1.3579, w: 2.7223 },
    pieces: [
      { file: 'set-dino-back.webp', size: { w: 845, h: 934 }, anchor: { x: 0, y: 0 }, pass: 'back', only: 'body' },
      { file: 'set-dino-front.webp', size: { w: 845, h: 934 }, anchor: { x: 0, y: 0 }, pass: 'mid', only: 'body' },
      { file: 'set-dino-head.webp', size: { w: 845, h: 934 }, anchor: { x: 0, y: 0 }, pass: 'mid', only: 'forms' }
    ],
    colorways: cw(['none', '#7fae6a'], ['hue-rotate(200deg) saturate(0.9)', '#8a7ed0'], ['sepia(1) saturate(2.6) hue-rotate(-10deg)', '#d8843c'])
  },
  {
    id: 'set-frog',
    slot: 'costume',
    mount: 'head',
    z: 4,
    fit: { tu: -0.8930, tv: -1.1517, w: 1.6978 },
    pieces: [
      { file: 'set-frog-back.webp', size: { w: 527, h: 213 }, anchor: { x: 0, y: 0 }, pass: 'back', only: 'body' },
      { file: 'set-frog-front.webp', size: { w: 527, h: 213 }, anchor: { x: 0, y: 0 }, pass: 'mid', only: 'body' },
      { file: 'set-frog-head.webp', size: { w: 527, h: 213 }, anchor: { x: 0, y: 0 }, pass: 'mid', only: 'forms' }
    ],
    colorways: cw(['none', '#7fb06a'], ['sepia(1) saturate(2.2) hue-rotate(10deg) brightness(1.15)', '#e0c048'], ['hue-rotate(160deg) saturate(0.8)', '#d890b8'])
  },
  {
    id: 'set-bunny',
    slot: 'costume',
    mount: 'head',
    z: 4,
    fit: { tu: -1.4923, tv: -1.9765, w: 2.5193 },
    pieces: [
      { file: 'set-bunny-back.webp', size: { w: 782, h: 1119 }, anchor: { x: 0, y: 0 }, pass: 'back', only: 'body' },
      { file: 'set-bunny-front.webp', size: { w: 782, h: 1119 }, anchor: { x: 0, y: 0 }, pass: 'mid', only: 'body' },
      { file: 'set-bunny-head.webp', size: { w: 782, h: 1119 }, anchor: { x: 0, y: 0 }, pass: 'mid', only: 'forms' }
    ],
    colorways: cw(['none', '#f2c4cc'], ['brightness(0.6) sepia(1) saturate(1.8)', '#a87a50'], ['saturate(0) brightness(0.6)', '#9a9a9a'])
  },
  {
    id: 'set-bee',
    slot: 'costume',
    mount: 'head',
    z: 4,
    fit: { tu: -1.6179, tv: -1.2258, w: 3.2023 },
    pieces: [
      { file: 'set-bee-back.webp', size: { w: 994, h: 818 }, anchor: { x: 0, y: 0 }, pass: 'back', only: 'body' },
      { file: 'set-bee-front.webp', size: { w: 994, h: 818 }, anchor: { x: 0, y: 0 }, pass: 'mid', only: 'body' },
      { file: 'set-bee-head.webp', size: { w: 994, h: 818 }, anchor: { x: 0, y: 0 }, pass: 'mid', only: 'forms' }
    ],
    colorways: cw(['none', '#f0c030'], ['hue-rotate(180deg) saturate(0.9)', '#4a90d0'], ['hue-rotate(-40deg) saturate(1.2)', '#e0603a'])
  },
  {
    id: 'set-wizard',
    slot: 'costume',
    mount: 'head',
    z: 4,
    fit: { tu: -1.6179, tv: -1.3064, w: 1.6044 },
    pieces: [
      { file: 'set-wizard-back.webp', size: { w: 498, h: 760 }, anchor: { x: 0, y: 0 }, pass: 'back', only: 'body' },
      { file: 'set-wizard-front.webp', size: { w: 498, h: 760 }, anchor: { x: 0, y: 0 }, pass: 'mid', only: 'body' },
      { file: 'set-wizard-head.webp', size: { w: 498, h: 760 }, anchor: { x: 0, y: 0 }, pass: 'mid', only: 'forms' },
      { file: 'set-wizard-held.webp', size: { w: 498, h: 760 }, anchor: { x: 0, y: 0 }, pass: 'mid', mount: 'hold', wing: 'l', only: 'body' }
    ],
    colorways: cw(['none', '#6a4aa0'], ['hue-rotate(110deg) saturate(0.9)', '#b04a5a'], ['hue-rotate(-120deg) saturate(0.8)', '#3a8a7a'])
  },
  {
    id: 'set-chef',
    slot: 'costume',
    mount: 'head',
    z: 4,
    fit: { tu: -1.2732, tv: -1.4997, w: 2.3872 },
    pieces: [
      { file: 'set-chef-back.webp', size: { w: 741, h: 834 }, anchor: { x: 0, y: 0 }, pass: 'back', only: 'body' },
      { file: 'set-chef-front.webp', size: { w: 741, h: 834 }, anchor: { x: 0, y: 0 }, pass: 'mid', only: 'body' },
      { file: 'set-chef-head.webp', size: { w: 741, h: 834 }, anchor: { x: 0, y: 0 }, pass: 'mid', only: 'forms' }
    ],
    colorways: cw(['none', '#d23a3c'], ['hue-rotate(210deg) saturate(0.9)', '#3f78c8'], ['hue-rotate(100deg) saturate(0.8)', '#4f9a5a'])
  },
  {
    id: 'set-detective',
    slot: 'costume',
    mount: 'head',
    z: 4,
    fit: { tu: -1.4278, tv: -1.2742, w: 1.8943 },
    pieces: [
      { file: 'set-detective-back.webp', size: { w: 588, h: 748 }, anchor: { x: 0, y: 0 }, pass: 'back', only: 'body' },
      { file: 'set-detective-front.webp', size: { w: 588, h: 748 }, anchor: { x: 0, y: 0 }, pass: 'mid', only: 'body' },
      { file: 'set-detective-head.webp', size: { w: 588, h: 748 }, anchor: { x: 0, y: 0 }, pass: 'mid', only: 'forms' },
      { file: 'set-detective-held.webp', size: { w: 588, h: 748 }, anchor: { x: 0, y: 0 }, pass: 'mid', mount: 'hold', wing: 'l', only: 'body' }
    ],
    colorways: cw(['none', '#9a7a52'], ['saturate(0.2) brightness(1.05)', '#9a9690'], ['hue-rotate(60deg) saturate(0.7)', '#7a8a4a'])
  },
  // ───────────── 点缀（owner 10-17「本体露出来，装扮只做点缀」后新加的小件） ─────────────
  {
    id: 'flower',
    slot: 'head',
    mount: 'head',
    z: 5,
    fit: { tu: -0.12, tv: -0.93, w: 0.56, rot: -10 },
    pieces: [{ file: 'flower.webp', size: { w: 332, h: 384 }, anchor: { x: 150, y: 372 }, pass: 'top', sway: { x: 150, y: 372, ramp: 300, k: -0.5 } }],
    small: 1.35,
    colorways: cw(['none', '#f0a0a8'], ['hue-rotate(200deg)', '#9cc4ea'], ['hue-rotate(45deg) saturate(1.2)', '#f3d36a'])
  },
  {
    id: 'starclip',
    slot: 'head',
    mount: 'head',
    z: 5,
    fit: { tu: 0.5, tv: -0.68, w: 0.56, rot: 18 },
    pieces: [{ file: 'starclip.webp', size: { w: 384, h: 323 }, anchor: { x: 190, y: 170 }, pass: 'top' }],
    small: 1.35,
    colorways: cw(['none', '#f0b43a'], ['hue-rotate(-50deg)', '#f0a0b8'], ['hue-rotate(170deg)', '#8cc0ea'])
  },
  {
    id: 'bell',
    slot: 'neck',
    mount: 'head',
    z: 3,
    fit: { tu: -1.1765, tv: 0.1820, w: 2.3260 },
    pieces: [
      { file: 'worn-bell-back.webp', size: { w: 722, h: 190 }, anchor: { x: 0, y: 0 }, pass: 'back' },
      { file: 'worn-bell-front.webp', size: { w: 722, h: 190 }, anchor: { x: 0, y: 0 }, pass: 'mid', bob: { x: 365, y: 160, r: 40, k: 0.6 } }
    ],
    forms: NO_TORSO,
    colorways: cw(['none', '#d23a3c'], ['hue-rotate(40deg) saturate(1.1) brightness(1.2)', '#e6b63c'], ['hue-rotate(225deg) brightness(0.8)', '#2f4f8a'])
  },
  // ───────────── 头上 ─────────────
  {
    id: 'beanie',
    slot: 'head',
    mount: 'head',
    z: 5,
    fit: { tu: 0, tv: -0.46, w: 1.95 },
    pieces: [{ file: 'beanie.webp', size: { w: 512, h: 509 }, anchor: { x: 256, y: 470 }, pass: 'top', bob: { x: 256, y: 95, r: 95, k: 0.9 } }],
    forms: { errorDome: { fit: { rot: -14, tu: 0.12 } }, sleep: { fit: { rot: 10 } } },
    colorways: cw(
      ['none', '#ec6a5c'],
      ['hue-rotate(195deg) saturate(0.7)', '#6f93c9'],
      ['hue-rotate(95deg) saturate(0.6)', '#8fb07a'],
      ['saturate(0.12) brightness(1.15)', '#d8d2cf']
    )
  },
  {
    id: 'crown',
    slot: 'head',
    mount: 'head',
    z: 5,
    fit: { tu: 0.05, tv: -0.84, w: 1.1, rot: 6 },
    pieces: [{ file: 'crown.webp', size: { w: 512, h: 374 }, anchor: { x: 256, y: 345 }, pass: 'top' }],
    forms: { errorDome: { fit: { rot: -22, tu: 0.25 } }, errorBall: { fit: { rot: -12 } } },
    small: 1.15,
    colorways: cw(['none', '#f0cf6e'], ['hue-rotate(-28deg) saturate(0.9)', '#efb39a'], ['saturate(0.1) brightness(1.1)', '#d8d8d8'])
  },
  {
    id: 'strawhat',
    slot: 'head',
    mount: 'head',
    z: 5,
    fit: { tu: 0, tv: -0.68, w: 2.55, rot: -4 },
    pieces: [{ file: 'strawhat.webp', size: { w: 512, h: 251 }, anchor: { x: 256, y: 185 }, pass: 'top' }],
    forms: {
      errorDome: { fit: { rot: -12, tv: -0.5 } },
      dots: { fit: { w: 2.3 } },
      bang: { fit: { w: 2.0, tv: -0.75 } }
    },
    colorways: cw(['none', '#e6c48f'], ['saturate(0.3) brightness(1.12)', '#efe6d6'], ['saturate(1.2) brightness(0.8)', '#b98a50'])
  },
  {
    id: 'tophat',
    slot: 'head',
    mount: 'head',
    z: 5,
    fit: { tu: 0.1, tv: -0.82, w: 1.25, rot: 9 },
    pieces: [{ file: 'tophat.webp', size: { w: 512, h: 368 }, anchor: { x: 256, y: 325 }, pass: 'top' }],
    forms: { errorDome: { fit: { rot: -26, tu: 0.3 } }, errorBall: { fit: { rot: -14 } } },
    colorways: cw(['none', '#4a4a4c'], ['sepia(1) hue-rotate(-50deg) saturate(3) brightness(0.75)', '#8d3236'], ['invert(0.85) saturate(0.2)', '#e2ded8'])
  },
  {
    id: 'partyhat',
    slot: 'head',
    mount: 'head',
    z: 5,
    fit: { tu: -0.12, tv: -0.8, w: 0.82, rot: -12 },
    pieces: [{ file: 'partyhat.webp', size: { w: 390, h: 512 }, anchor: { x: 195, y: 478 }, pass: 'top', bob: { x: 195, y: 55, r: 60, k: 1.0 } }],
    forms: { errorDome: { fit: { rot: 22, tu: -0.25 } } },
    colorways: cw(['none', '#a9c9ea'], ['hue-rotate(140deg)', '#eab0c8'], ['hue-rotate(-60deg) saturate(0.9)', '#a7dcc6'])
  },
  {
    id: 'flowercrown',
    slot: 'head',
    mount: 'head',
    z: 5,
    fit: { tu: 0, tv: -0.74, w: 1.62 },
    pieces: [
      { file: 'flowercrown-back.webp', size: { w: 512, h: 239 }, anchor: { x: 259, y: 98 }, pass: 'back' },
      { file: 'flowercrown-front.webp', size: { w: 512, h: 239 }, anchor: { x: 259, y: 98 }, pass: 'top' }
    ],
    small: 1.35,
    colorways: cw(['none', '#f3b8c8'], ['hue-rotate(-35deg) saturate(1.3)', '#f0a070'], ['saturate(0.25) brightness(1.15)', '#e8e6e6'])
  },
  {
    id: 'santahat',
    slot: 'head',
    mount: 'head',
    z: 5,
    fit: { tu: 0.04, tv: -0.56, w: 2.05 },
    pieces: [
      {
        file: 'santahat.webp',
        size: { w: 512, h: 406 },
        anchor: { x: 236, y: 372 },
        pass: 'top',
        sway: { x: 330, y: 80, ramp: 120, x0: 330, x1: 512, k: 0.6 },
        bob: { x: 440, y: 300, r: 70, k: 0.8 }
      }
    ],
    forms: { errorDome: { fit: { rot: -10, tu: 0.1 } } },
    colorways: cw(['none', '#d8343a'], ['hue-rotate(130deg) saturate(0.6) brightness(0.8)', '#3d7a5a'], ['hue-rotate(-20deg) saturate(0.5) brightness(1.3)', '#f1a7b5'])
  },
  {
    id: 'bow',
    slot: 'head',
    mount: 'head',
    z: 5,
    fit: { tu: 0.5, tv: -0.82, w: 0.78, rot: 20 },
    pieces: [{ file: 'bow.webp', size: { w: 512, h: 374 }, anchor: { x: 256, y: 200 }, pass: 'top', bob: { x: 256, y: 187, r: 300, k: 0.25 } }],
    small: 1.4,
    colorways: cw(['none', '#f2a6b6'], ['saturate(1.8) brightness(0.85)', '#e0505e'], ['hue-rotate(185deg)', '#9cc4ea'], ['hue-rotate(240deg) saturate(0.8)', '#c3a8e6'])
  },
  // ───────────── 耳朵 ─────────────
  {
    id: 'headphones',
    slot: 'ears',
    mount: 'head',
    z: 5,
    fit: { tu: -1.4890, tv: -1.1002, w: 2.9414 },
    pieces: [{ file: 'worn-headphones-back.webp', size: { w: 913, h: 489 }, anchor: { x: 0, y: 0 }, pass: 'back' }, { file: 'worn-headphones-front.webp', size: { w: 913, h: 489 }, anchor: { x: 0, y: 0 }, pass: 'top' }],
    forms: { errorDome: { hide: true } },
    conflicts: HATS,
    colorways: cw(['none', '#7fa898'], ['hue-rotate(185deg) saturate(0.9)', '#e3a0b0'], ['saturate(0) brightness(0.45)', '#4a4a4a'], ['saturate(0.1) brightness(1.3)', '#eee'])
  },
  // ───────────── 脸上 ─────────────
  {
    id: 'glasses',
    slot: 'face',
    mount: 'eyes',
    z: 6,
    fit: { tu: 0, tv: 0.02, w: 1.0 },
    pieces: [
      {
        file: 'glasses.webp',
        size: { w: 512, h: 211 },
        anchor: { x: 256, y: 107 },
        pass: 'top',
        lens: [
          { x: 138.5, y: 107.5 },
          { x: 372.8, y: 107.3 }
        ]
      }
    ],
    colorways: cw(['none', '#b07a52'], ['saturate(0.2) brightness(0.45)', '#4a4440'], ['hue-rotate(-30deg) saturate(1.1) brightness(1.25)', '#e9a0a8'])
  },
  {
    id: 'sunglasses',
    slot: 'face',
    mount: 'eyes',
    z: 6,
    fit: { tu: 0, tv: 0.02, w: 1.0 },
    pieces: [
      {
        file: 'sunglasses.webp',
        size: { w: 512, h: 203 },
        anchor: { x: 256, y: 106 },
        pass: 'top',
        lens: [
          { x: 137.6, y: 105.7 },
          { x: 376.1, y: 105.6 }
        ]
      }
    ],
    colorways: cw(['none', '#d33a3a'], ['saturate(0) brightness(0.35)', '#333'], ['hue-rotate(25deg) brightness(1.15)', '#ee8a3a'])
  },
  // ───────────── 脖子 ─────────────
  {
    id: 'scarf',
    slot: 'neck',
    mount: 'head',
    z: 3,
    fit: { tu: -1.2474, tv: 0.1305, w: 2.4742 },
    pieces: [{ file: 'worn-scarf-back.webp', size: { w: 768, h: 442 }, anchor: { x: 0, y: 0 }, pass: 'back' }, { file: 'worn-scarf-front.webp', size: { w: 768, h: 442 }, anchor: { x: 0, y: 0 }, pass: 'mid', sway: { x: 190, y: 175, ramp: 120, x0: 130, x1: 255, k: 0.9 } }],
    forms: NO_TORSO,
    colorways: cw(['none', '#d9a93a'], ['hue-rotate(-45deg) saturate(1.1) brightness(0.8)', '#b2484a'], ['hue-rotate(150deg) saturate(0.8)', '#4f9ab0'], ['saturate(0.15) brightness(1.2)', '#e9e2d4'])
  },
  {
    id: 'bowtie',
    slot: 'neck',
    mount: 'head',
    z: 3,
    fit: { tu: 0.02, tv: 0.68, w: 0.95 },
    pieces: [{ file: 'bowtie.webp', size: { w: 512, h: 297 }, anchor: { x: 256, y: 148 }, pass: 'mid' }],
    forms: NO_TORSO,
    small: 1.2,
    colorways: cw(['none', '#d2343c'], ['hue-rotate(220deg) brightness(0.7)', '#2f4f8a'], ['hue-rotate(45deg) brightness(1.2)', '#f0c040'], ['saturate(0) brightness(0.4)', '#333'])
  },
  // ───────────── 背后 ─────────────
  {
    id: 'cape',
    slot: 'back',
    mount: 'head',
    z: 2,
    fit: { tu: -1.6179, tv: 0.1176, w: 3.1862 },
    pieces: [
      { file: 'worn-cape-back.webp', size: { w: 989, h: 486 }, anchor: { x: 0, y: 0 }, pass: 'back', sway: { x: 502, y: 150, ramp: 250, k: 0.3 } },
      { file: 'worn-cape-front.webp', size: { w: 989, h: 486 }, anchor: { x: 0, y: 0 }, pass: 'mid' }
    ],
    forms: NO_TORSO,
    conflicts: ['scarf', 'bowtie'],
    colorways: cw(['none', '#c8262c'], ['hue-rotate(-90deg) saturate(0.8)', '#7b4fb0'], ['hue-rotate(-140deg) saturate(0.7) brightness(0.8)', '#2f4f8a'])
  },
  {
    id: 'backpack',
    slot: 'back',
    mount: 'head',
    z: 1,
    fit: { tu: -1.2829, tv: -0.5783, w: 2.6546 },
    pieces: [
      { file: 'worn-backpack-back.webp', size: { w: 824, h: 611 }, anchor: { x: 0, y: 0 }, pass: 'back', sway: { x: 680, y: 20, ramp: 250, x0: 590, x1: 824, k: 0.5 } },
      { file: 'worn-backpack-front.webp', size: { w: 824, h: 611 }, anchor: { x: 0, y: 0 }, pass: 'mid' }
    ],
    forms: NO_TORSO,
    colorways: cw(['none', '#eda55e'], ['hue-rotate(180deg) saturate(0.8)', '#7fb0dc'], ['hue-rotate(60deg) saturate(0.7)', '#94c07a'], ['hue-rotate(-30deg) saturate(0.8) brightness(1.1)', '#f0a0a8'])
  },
  // ───────────── 脚下 ─────────────
  {
    id: 'skateboard',
    slot: 'feet',
    mount: 'ground',
    z: 0,
    fit: { tu: 0, tv: 0, w: 1.55 },
    pieces: [{ file: 'skateboard.webp', size: { w: 512, h: 169 }, anchor: { x: 256, y: 34 }, pass: 'back' }],
    colorways: cw(['none', '#7fae94'], ['hue-rotate(-140deg) saturate(1.3)', '#e39058'], ['hue-rotate(110deg) saturate(0.9)', '#9b88c4'], ['saturate(0.1) brightness(0.55)', '#555'])
  },
  // ───────────── 手里 ─────────────
  {
    id: 'umbrella',
    slot: 'hand',
    mount: 'wing',
    z: 7,
    fit: { tu: 34, tv: 26, w: 1.3, rot: 0 },
    pieces: [{ file: 'umbrella.webp', size: { w: 512, h: 498 }, anchor: { x: 248, y: 452 }, pass: 'top', sway: { x: 248, y: 452, ramp: 400, k: -0.12 } }],
    forms: NO_TORSO, // 变形后的形态都没有翅膀,伞没处握(也就不为它缩取景)
    conflicts: ['headphones'],
    colorways: cw(['none', '#f3df8a'], ['hue-rotate(-60deg) saturate(0.9)', '#f2b0c0'], ['hue-rotate(150deg) saturate(0.8)', '#a0c8ea'])
  }
]

export const OUTFIT_BY_ID: ReadonlyMap<string, OutfitDef> = new Map(OUTFIT_DEFS.map((d) => [d.id, d]))

/** 位置的先后(DIY 页签按这个顺序列) */
export const SLOT_ORDER: readonly Slot[] = ['costume', 'head', 'ears', 'face', 'neck', 'back', 'feet', 'hand']

/** 穿上一件(DIY):同位置的、和它打架的先摘下。返回新的一身和摘下的那几件(给界面说一句「摘下了 X」) */
export function putOn(worn: readonly WearItem[], id: string, cw = 0): { wear: WearItem[]; removed: string[] } {
  const def = OUTFIT_BY_ID.get(id)
  if (!def) throw new Error(`unknown outfit id: ${id}`)
  const removed = worn.filter((w) => w.id !== id && clashes(OUTFIT_BY_ID.get(w.id)!, def)).map((w) => w.id)
  const kept = worn.filter((w) => w.id !== id && !removed.includes(w.id))
  return { wear: [...kept, { id, cw }], removed }
}

export function takeOff(worn: readonly WearItem[], id: string): WearItem[] {
  return worn.filter((w) => w.id !== id)
}

export function recolor(worn: readonly WearItem[], id: string, cw: number): WearItem[] {
  return worn.map((w) => (w.id === id ? { id, cw } : w))
}
