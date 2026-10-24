import { describe, expect, it } from 'vitest'
import {
  BODY_CHROMA,
  BODY_COLORS,
  BODY_LIGHTNESS,
  CREAM_REFERENCE,
  DEFAULT_IDENTITY,
  REST_FACES,
  agentIdentity,
  bodyTint,
  oklchToLinearSrgb
} from '@/components/agentAvatar/engine/identity'
import { EXPRESSIONS } from '@/components/agentAvatar/engine/spec'
import { agentLookPoster } from '@/components/agentAvatar/posters'

const uuid = (i: number) =>
  `${(0x1000000 + i * 7919).toString(16).padStart(8, '0')}-${(i * 31) % 10000}-4abc-8def-${String(i).padStart(12, '0')}`

describe('agent identity layer (身份层:身体颜色 + 休息表情)', () => {
  it('同一个 id 永远同一个样子;空 id = 奶油 + 平静', () => {
    const id = '0b6f3c1e-1a2b-4c3d-9e8f-001122334455'
    expect(agentIdentity(id)).toEqual(agentIdentity(id))
    expect(agentIdentity(` ${id} `)).toEqual(agentIdentity(id))
    expect(agentIdentity('')).toEqual(DEFAULT_IDENTITY)
    expect(agentIdentity(null)).toEqual(DEFAULT_IDENTITY)
    expect(DEFAULT_IDENTITY).toEqual({ color: 0, rest: 'neutral' })
  })

  it('12 色 × 6 种休息表情分得匀(1.2 万个 id,每格偏差 < 15%)', () => {
    const n = 12000
    const colors = new Array(BODY_COLORS.length).fill(0)
    const rests = new Map<string, number>()
    for (let i = 0; i < n; i++) {
      const it = agentIdentity(uuid(i))
      colors[it.color]++
      rests.set(it.rest, (rests.get(it.rest) ?? 0) + 1)
    }
    for (const c of colors) expect(Math.abs(c - n / 12) / (n / 12)).toBeLessThan(0.15)
    expect(rests.size).toBe(REST_FACES.length)
    for (const c of rests.values()) expect(Math.abs(c - n / REST_FACES.length) / (n / REST_FACES.length)).toBeLessThan(0.15)
  })

  it('颜色与表情是两根独立的轴(同色的 agent 表情照样各不相同)', () => {
    const restsOfCream = new Set<string>()
    for (let i = 0; i < 3000; i++) {
      const it = agentIdentity(uuid(i))
      if (it.color === 0) restsOfCream.add(it.rest)
    }
    expect(restsOfCream.size).toBe(REST_FACES.length)
  })

  it('色板是有序的一圈:12 格、每格 30°、从奶油的色相起步', () => {
    expect(BODY_COLORS).toHaveLength(12)
    for (let i = 0; i < BODY_COLORS.length; i++) {
      const step = (BODY_COLORS[i].hue - BODY_COLORS[0].hue + 360) % 360
      expect(step).toBeCloseTo(30 * i, 6)
    }
  })

  it('全家同亮度同彩度,且 12 格都在 sRGB 色域内(不会被削色)', () => {
    for (const c of BODY_COLORS) {
      const rgb = oklchToLinearSrgb(BODY_LIGHTNESS, BODY_CHROMA, c.hue)
      for (const ch of rgb) {
        expect(ch).toBeGreaterThanOrEqual(0)
        expect(ch).toBeLessThanOrEqual(1)
      }
    }
  })

  it('换色比值 = 目标色 / 奶油参考色(乘回去就是目标色)', () => {
    for (let i = 0; i < BODY_COLORS.length; i++) {
      const target = oklchToLinearSrgb(BODY_LIGHTNESS, BODY_CHROMA, BODY_COLORS[i].hue)
      const tint = bodyTint(i)
      for (let k = 0; k < 3; k++) expect(tint[k] * CREAM_REFERENCE[k]).toBeCloseTo(target[k], 9)
    }
    expect(bodyTint(12)).toEqual(bodyTint(0))
  })

  it('自动分配的 6 种休息表情都在 16 种之内,且不含会一直抖 / 跳 / 冒特效、或读成状态 / 读歪的那几种', () => {
    const all = new Set(EXPRESSIONS.map((e) => e.id))
    for (const r of REST_FACES) expect(all.has(r)).toBe(true)
    for (const bad of ['angry', 'sad', 'scared', 'excited', 'laughing', 'confused', 'suspicious', 'sleepy', 'proud', 'unimpressed'])
      expect(REST_FACES).not.toContain(bad)
  })

  it('静态定格按同一个身份取色(12 张各不相同)', () => {
    const seen = new Map<number, string>()
    for (let i = 0; i < 400; i++) {
      const id = uuid(i)
      const url = agentLookPoster(agentIdentity(id))
      const color = agentIdentity(id).color
      if (seen.has(color)) expect(seen.get(color)).toBe(url)
      else seen.set(color, url)
    }
    expect(new Set(seen.values()).size).toBe(12)
  })
})
