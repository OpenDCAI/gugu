import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { GuguEngine } from '@/components/agentAvatar/engine/engine'
import { drawnLook, lookDiff } from '@/components/agentAvatar/engine/draw'
import { NEUTRAL_BODY } from '@/components/agentAvatar/engine/geometry'
import { CHARACTER_BY_ID, DEFAULT_CHARACTER } from '@/components/agentAvatar/engine/characters'
import { OUTFIT_BY_ID, OUTFIT_DEFS, clashes } from '@/components/agentAvatar/engine/outfitCatalog'
import { OutfitDraw, OutfitRig } from '@/components/agentAvatar/engine/outfits'
import type { GuguFrame } from '@/components/agentAvatar/engine/engine'
import { buildLookUrl, lookObjectPath, parseAgentLook, sameLook, type AgentLook } from '@/components/agentAvatar/look'

const HOST = 'https://devdb.example.space/storage/v1/object/public/avatars'
const url = (look: AgentLook) => buildLookUrl(`${HOST}/${lookObjectPath(look.color)}`, look.rest, look.wear)
const ASSETS = path.join(process.cwd(), 'apps/desktop/src/components/agentAvatar/assets/outfits')

describe('形象地址里的装扮(wear)', () => {
  it('拼出来再读回去是同一身,顺序不变', () => {
    const look: AgentLook = { color: 5, rest: 'happy', wear: [{ id: 'set-bear', cw: 0 }, { id: 'glasses', cw: 1 }] }
    const u = url(look)
    expect(u).toBe(`${HOST}/agent-look/v1/sky.webp?rest=happy&wear=set-bear.0,glasses.1`)
    expect(parseAgentLook(u)).toEqual(look)
  })

  it('没有 wear 参数 = 老形象(wear 不给);wear= 为空 = 明确不戴', () => {
    expect(parseAgentLook(`${HOST}/agent-look/v1/sky.webp?rest=happy`)).toEqual({ color: 5, rest: 'happy' })
    expect(parseAgentLook(`${HOST}/agent-look/v1/sky.webp?rest=happy&wear=`)).toEqual({ color: 5, rest: 'happy', wear: [] })
    expect(url({ color: 5, rest: 'happy' })).not.toContain('wear')
    expect(url({ color: 5, rest: 'happy', wear: [] })).toMatch(/&wear=$/)
  })

  it('认不出的 id、越界的配色、和前面冲突的:跳过那一件,其余照戴', () => {
    const parsed = parseAgentLook(`${HOST}/agent-look/v1/sky.webp?rest=happy&wear=jetpack.0,beanie.99,beanie.1,headphones.0,glasses.0`)
    // headphones 和所有帽子冲突(先出现的毛线帽留下)
    expect(parsed?.wear).toEqual([{ id: 'beanie', cw: 1 }, { id: 'glasses', cw: 0 }])
  })

  it('比形象时装扮也算:老形象 ≠ 明确不戴 ≠ 戴着', () => {
    const base = { color: 2, rest: 'shy' as const }
    expect(sameLook(base, { ...base })).toBe(true)
    expect(sameLook(base, { ...base, wear: [] })).toBe(false)
    expect(sameLook({ ...base, wear: [{ id: 'crown', cw: 0 }] }, { ...base, wear: [{ id: 'crown', cw: 1 }] })).toBe(false)
    expect(sameLook({ ...base, wear: [{ id: 'crown', cw: 0 }] }, { ...base, wear: [{ id: 'crown', cw: 0 }] })).toBe(true)
  })
})

describe('装扮目录', () => {
  it('id 不重复、每片素材都在包里、每件(轻套装也一样)至少 3 种配色', () => {
    expect(OUTFIT_BY_ID.size).toBe(OUTFIT_DEFS.length)
    for (const d of OUTFIT_DEFS) {
      expect(d.colorways.length, d.id).toBeGreaterThanOrEqual(3)
      expect(d.colorways[0].filter, `${d.id}: 第一种是原色`).toBe('none')
      for (const pc of d.pieces) expect(existsSync(path.join(ASSETS, pc.file)), `${d.id}: ${pc.file}`).toBe(true)
    }
  })

  it('冲突是对称的;同一位置只能一件;套装和头、耳、脖、背打架,和脸上的不打架', () => {
    for (const a of OUTFIT_DEFS) for (const b of OUTFIT_DEFS) expect(clashes(a, b)).toBe(clashes(b, a))
    const get = (id: string) => OUTFIT_BY_ID.get(id)!
    expect(clashes(get('beanie'), get('crown'))).toBe(true)
    expect(clashes(get('set-bear'), get('scarf'))).toBe(true)
    expect(clashes(get('set-bear'), get('glasses'))).toBe(false)
    expect(clashes(get('headphones'), get('tophat'))).toBe(true)
  })
})

/** 一帧身体一动不动的画面(只给弹簧读) */
function stillFrame(): GuguFrame {
  return { body: { ...NEUTRAL_BODY } } as GuguFrame
}

describe('装扮的二级运动', () => {
  it('身体不动,弹簧几拍之内停下(没有常驻的风:否则静止的小鸟每帧都要重画)', () => {
    const rig = new OutfitRig()
    const moving = stillFrame()
    for (let i = 0; i < 20; i++) {
      moving.body.hop = i % 2 ? 40 : 0 // 先颠几下,把弹簧推起来
      rig.update(1 / 60, moving)
    }
    expect(Math.abs(rig.bob.x) + Math.abs(rig.sway.x)).toBeGreaterThan(0.01)
    const f = stillFrame()
    for (let i = 0; i < 240; i++) rig.update(1 / 60, f)
    expect(Math.abs(rig.sway.x)).toBeLessThan(1e-3)
    expect(Math.abs(rig.bob.x)).toBeLessThan(1e-2)
    expect(Math.abs(rig.board.x)).toBeLessThan(1e-2)
  })
})

describe('画出来是什么样(runtime 据此决定重不重画)', () => {
  const o = { w: 128, h: 128, dpr: 2, shape: 'free' as const, bg: false, crop: 'full' as const, fx: false }
  // runtime 的「同一张」:差不到半个 CSS 像素
  const sameDrawn = (a: number[], b: number[]) => lookDiff(a, b) < 0.5 * o.dpr

  it('戴上帽子画面就不同(换配色外形一样,靠 runtime 的画法键 outfit.key 重画);帽子让取景装下它', () => {
    const engine = new GuguEngine(3)
    engine.update(1 / 60, null)
    const ch = CHARACTER_BY_ID[DEFAULT_CHARACTER]
    const bare = drawnLook(engine.frame, o, [])
    const hat = new OutfitDraw(ch)
    hat.set([{ id: 'tophat', cw: 0 }])
    const withHat = drawnLook(engine.frame, o, [], hat)
    expect(sameDrawn(bare, withHat)).toBe(false)
    expect(hat.viewHead()).toBeGreaterThan(0)
    const other = new OutfitDraw(ch)
    other.set([{ id: 'tophat', cw: 2 }])
    expect(sameDrawn(withHat, drawnLook(engine.frame, o, [], other))).toBe(true)
  })

  it('半身取景不画滑板:戴不戴滑板画面一样', () => {
    const engine = new GuguEngine(3)
    engine.update(1 / 60, null)
    const ch = CHARACTER_BY_ID[DEFAULT_CHARACTER]
    const board = new OutfitDraw(ch)
    board.set([{ id: 'skateboard', cw: 0 }])
    const bust = { ...o, crop: 'bust' as const }
    expect(sameDrawn(drawnLook(engine.frame, bust, []), drawnLook(engine.frame, bust, [], board))).toBe(true)
    expect(sameDrawn(drawnLook(engine.frame, o, []), drawnLook(engine.frame, o, [], board))).toBe(false)
  })

  it('取景只为当前形态看得见的装扮让位:小雨伞在睡团上收起了,就不再为它把整只缩小', () => {
    const ch = CHARACTER_BY_ID[DEFAULT_CHARACTER]
    const d = new OutfitDraw(ch)
    d.set([{ id: 'umbrella', cw: 0 }])
    expect(d.viewHalfWidth()).toBeGreaterThan(0)
    const frame = (form: string) => ({ body: { ...NEUTRAL_BODY }, layers: [{ id: form }] }) as unknown as GuguFrame
    d.update(1 / 60, frame('sleep')) // 第一帧直接落位
    expect(d.viewHalfWidth()).toBe(0)
    d.update(1 / 60, frame('body')) // 之后换形态是缓过去的
    expect(d.viewHalfWidth()).toBeGreaterThan(0)
    for (let i = 0; i < 120; i++) d.update(1 / 60, frame('body'))
    const full = new OutfitDraw(ch)
    full.set([{ id: 'umbrella', cw: 0 }])
    expect(d.viewHalfWidth()).toBeCloseTo(full.viewHalfWidth(), 3)
  })

  it('认不出的 id 当场报错(读地址时已经筛过,能走到这里就是调用方的错)', () => {
    const d = new OutfitDraw(CHARACTER_BY_ID[DEFAULT_CHARACTER])
    expect(() => d.set([{ id: 'jetpack', cw: 0 }])).toThrow(/unknown outfit/)
  })
})
