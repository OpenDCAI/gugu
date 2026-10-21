/**
 * packs.fjj.ts —— fjj 版各「状态形态」的素材包（由 流水线/素材化/build_part.py 从第 7 轮设计稿出图抠出，数值全是实测；
 * 不要手改，重新跑脚本生成）。素材坐标 = 各自 png 的像素；落地点 pivot = 轮廓最低处中心。
 */
import type { Pack } from './characters'
import faceball from '../assets/forms/fjj-faceball.webp'
import stem from '../assets/forms/fjj-stem.webp'
import dome from '../assets/forms/fjj-dome.webp'
import sleep from '../assets/forms/fjj-sleep.webp'
import roll from '../assets/forms/fjj-roll.webp'
import plain from '../assets/forms/fjj-plain.webp'

export const FJJ_PACKS: Record<string, Pack> = {
  'fjj-faceball': {
    id: 'fjj-faceball',
    sprite: faceball,
    spr: { w: 430, h: 450 },
    pivot: { x: 216.5, y: 434.0 },
    neck: { x: 215.0, y: 247.5 },
    headBand: [135.0, 427.5],
    chest: { y: 247.5, s: 135.0 },
    lift: 427.5,
    rollGain: 0.6,
    lookGain: 0.7,
    head: { x: 218.5, y: 176.3, r: 194.6 },
    eye: {
      rs: 182.1,
      yaw0: 0,
      pitch0: 0,
      roll0: 0.04,
      split: 24.0,
      r: 39.4,
      aspect: 1.283,
      gloss: { x: -0.3, y: -0.5, r: 0.15 },
      socket: 0.5
    },
    shadow: { rx: 172.0, ry: 22.5 }
  },
  'fjj-stem': {
    id: 'fjj-stem',
    sprite: stem,
    spr: { w: 346, h: 640 },
    pivot: { x: 171.0, y: 622.0 },
    neck: { x: 173.0, y: 352.0 },
    headBand: [192.0, 608.0],
    chest: { y: 352.0, s: 192.0 },
    lift: 608.0,
    rollGain: 0.6,
    lookGain: 0.7,
    head: { x: 174.2, y: 172.5, r: 167.7 },
    eye: {
      rs: 157.0,
      yaw0: 0,
      pitch0: 0,
      roll0: -0.08,
      split: 24.0,
      r: 35.6,
      aspect: 1.377,
      gloss: { x: -0.3, y: -0.5, r: 0.15 },
      socket: 0.5
    },
    shadow: { rx: 138.4, ry: 32.0 }
  },
  'fjj-dome': {
    id: 'fjj-dome',
    sprite: dome,
    spr: { w: 612, h: 320 },
    pivot: { x: 305.0, y: 303.0 },
    neck: { x: 306.0, y: 176.0 },
    headBand: [96.0, 304.0],
    chest: { y: 176.0, s: 96.0 },
    lift: 304.0,
    rollGain: 0.6,
    lookGain: 0.7,
    head: { x: 311.0, y: 166.1, r: 200.2 },
    eye: {
      rs: 187.4,
      yaw0: 0,
      pitch0: 0,
      roll0: 0.1,
      split: 24.0,
      r: 43.0,
      aspect: 1.077,
      gloss: { x: -0.3, y: -0.5, r: 0.15 },
      socket: 0.5
    },
    shadow: { rx: 244.8, ry: 16.0 }
  },
  'fjj-sleep': {
    id: 'fjj-sleep',
    sprite: sleep,
    spr: { w: 581, h: 520 },
    pivot: { x: 288.5, y: 502.0 },
    neck: { x: 290.5, y: 286.0 },
    headBand: [156.0, 494.0],
    chest: { y: 286.0, s: 156.0 },
    lift: 494.0,
    rollGain: 0.6,
    lookGain: 0.7,
    head: { x: 305.7, y: 257.2, r: 235.5 },
    eye: {
      rs: 220.5,
      yaw0: 0,
      pitch0: 0,
      roll0: 2.07,
      split: 24.0,
      r: 48.1,
      aspect: 0.472,
      gloss: { x: -0.3, y: -0.5, r: 0.15 },
      socket: 0.5
    },
    shadow: { rx: 232.4, ry: 26.0 }
  },
  'fjj-roll': {
    id: 'fjj-roll',
    sprite: roll,
    spr: { w: 481, h: 500 },
    pivot: { x: 293.0, y: 484.0 },
    neck: { x: 240.5, y: 275.0 },
    headBand: [150.0, 475.0],
    chest: { y: 275.0, s: 150.0 },
    lift: 475.0,
    rollGain: 0.6,
    lookGain: 0.7,
    head: { x: 249.9, y: 192.8, r: 188.6 },
    eye: {
      rs: 176.5,
      yaw0: 0,
      pitch0: 0,
      roll0: 22.9,
      split: 24.0,
      r: 46.4,
      aspect: 1.121,
      gloss: { x: -0.3, y: -0.5, r: 0.15 },
      socket: 0.5
    },
    shadow: { rx: 192.4, ry: 25.0 }
  },
  'fjj-plain': {
    id: 'fjj-plain',
    sprite: plain,
    spr: { w: 337, h: 340 },
    pivot: { x: 168.5, y: 327.0 },
    neck: { x: 168.5, y: 187.0 },
    headBand: [102.0, 323.0],
    chest: { y: 187.0, s: 102.0 },
    lift: 323.0,
    rollGain: 0.6,
    lookGain: 0.7,
    head: { x: 168.5, y: 170.0, r: 168.5 },
    eye: {
      rs: 100,
      yaw0: 0,
      pitch0: 0,
      roll0: 0,
      split: 24,
      r: 40,
      aspect: 1.2,
      gloss: { x: -0.3, y: -0.5, r: 0.15 },
      socket: 0.5
    },
    shadow: { rx: 134.8, ry: 17.0 }
  }
}
