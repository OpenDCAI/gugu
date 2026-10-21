import { describe, expect, it, vi } from 'vitest'
import { CHARACTER_BY_ID, type Pack } from '@/components/agentAvatar/engine/characters'
import { NEUTRAL_BODY, warp, warpWith, warpWeights, type BodyParams } from '@/components/agentAvatar/engine/geometry'
import { GuguEngine } from '@/components/agentAvatar/engine/engine'
import { paintGL } from '@/components/agentAvatar/engine/draw'
import { GRID_X, GRID_Y, type GuguGL } from '@/components/agentAvatar/engine/gl'
import { STATES } from '@/components/agentAvatar/engine/spec'

const character = CHARACTER_BY_ID['fjj-beak']
const packs: Pack[] = [character, ...Object.values(character.forms!)]

describe('fixed avatar body mesh', () => {
  it('overwrites scratch coefficients when dynamic points move between packs', () => {
    const scratch = warpWeights(character.face!.x, character.face!.y, character)
    expect(scratch.face).toBeGreaterThan(0)
    const plain = character.forms!.plain
    expect(warpWeights(0, 0, plain, scratch)).toBe(scratch)
    expect(scratch).toEqual(warpWeights(0, 0, plain))
    expect(scratch.face).toBe(0)
    expect(scratch.leftWing).toBe(0)
    expect(scratch.rightWing).toBe(0)
  })

  it('preserves every vertex for all sprite packs, including face and wing deformation', () => {
    const bodies: BodyParams[] = [
      NEUTRAL_BODY,
      { sx: 0.7, sy: 1.4, lean: -90, roll: 43, turn: -60, nod: 27, puff: 0.2, hop: 81, wob: 21, wobPhase: 1.7, fx: -25, fy: 15, wl: -1, wr: 1.25 },
      { sx: 1.3, sy: 0.6, lean: 75, roll: -37, turn: 48, nod: -18, puff: -0.15, hop: -4, wob: -14, wobPhase: 8.2, fx: 30, fy: -20, wl: 1.25, wr: -1 }
    ]
    const direct: [number, number] = [0, 0]
    const cached: [number, number] = [0, 0]
    for (const pack of packs) {
      for (let j = 0; j <= GRID_Y; j++) {
        const y = (j / GRID_Y) * pack.spr.h
        for (let i = 0; i <= GRID_X; i++) {
          const x = (i / GRID_X) * pack.spr.w
          const weights = warpWeights(x, y, pack)
          for (const body of bodies) {
            warp(x, y, body, direct, pack)
            warpWith(x, y, body, cached, pack, weights)
            expect(cached, `${pack.id} at ${i},${j}`).toEqual(direct)
          }
        }
      }
    }
  })

  it('reuses fixed weights across avatars while producing the same vertex buffers', () => {
    // A separate pack identity ensures this test owns the first cache population.
    const engine = new GuguEngine(7)
    engine.update(1 / 60, null)
    const pack = { ...character }
    engine.frame.layers[0].parts.list[0].pack = pack
    const verts = new Float32Array((GRID_X + 1) * (GRID_Y + 1) * 2)
    const gl = { verts, begin: () => [0, 0], drawSprite: () => {} } as unknown as GuguGL
    const opts = { w: 80, h: 80, dpr: 2, shape: 'circle' as const, bg: false, crop: 'full' as const, fx: false }
    const hypot = vi.spyOn(Math, 'hypot')
    try {
      paintGL(gl, engine.frame, opts, null)
      expect(hypot.mock.calls.length).toBeGreaterThan(0)
      const first = verts.slice()
      hypot.mockClear()
      paintGL(gl, engine.frame, opts, null)
      expect(hypot).not.toHaveBeenCalled()
      expect(verts).toEqual(first)
    } finally {
      hypot.mockRestore()
    }
  })

  it('matches uncached deformation on every simulated frame through state transitions', () => {
    const engine = new GuguEngine(19)
    const direct: [number, number] = [0, 0]
    const cached: [number, number] = [0, 0]
    const samples = new Map(packs.map(pack => [pack, [
      [0, 0], [pack.spr.w / 2, pack.spr.h / 2], [pack.spr.w, pack.spr.h],
      [pack.neck.x, pack.headBand[0]], [pack.pivot.x, pack.headBand[1]]
    ].map(([x, y]) => ({ x, y, weights: warpWeights(x, y, pack) }))]))
    for (const state of STATES) {
      engine.setState(state.id)
      for (let frame = 0; frame < 120; frame++) {
        engine.update(1 / 60, { x: Math.sin(frame / 20), y: Math.cos(frame / 30) })
        for (const layer of engine.frame.layers) {
          for (let i = 0; i < layer.parts.n; i++) {
            const part = layer.parts.list[i]
            for (const point of samples.get(part.pack)!) {
              warp(point.x, point.y, part.body, direct, part.pack)
              warpWith(point.x, point.y, part.body, cached, part.pack, point.weights)
              expect(cached).toEqual(direct)
            }
          }
        }
      }
    }
  })
})
