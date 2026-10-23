import { describe, expect, it } from 'vitest'
import { CHARACTER_BY_ID } from '../../../../apps/desktop/src/components/agentAvatar/engine/characters'
import { halfWidth, newPose, piecePose, shoulderCover } from '../../../../apps/desktop/src/components/agentAvatar/engine/rig'

// 翅膀、喙、脚是刚体部件(rig.ts)。owner 10-22 看过一版「转圈时翅膀和身体分离了」:这里守住两件事 ——
// 静止时部件就在素材原位(转圈和静止是同一张画),转到任何角度翅根都压在身体轮廓以内。
const rig = CHARACTER_BY_ID['fjj-beak'].rig!
const still = { wl: 0, wr: 0, yaw: 0, fx: 0, fy: 0 }

describe('刚体部件', () => {
  it('静止时每个部件都在原位、不缩放、不转', () => {
    for (const pc of rig.pieces) {
      const ps = piecePose(rig, pc, still, newPose())
      expect([ps.dx, ps.dy], pc.id).toEqual([0, 0])
      expect(ps.m.map((v) => Math.round(v * 1e9) / 1e9 + 0), pc.id).toEqual([1, 0, 0, 1])
      expect(ps.depth, pc.id).toBeGreaterThan(0)
    }
  })

  it('转一整圈的每一度,翅根都落在那一高度的身体轮廓以内;转到背面就画在身体后面', () => {
    for (const pc of rig.pieces.filter((p) => p.kind === 'wing')) {
      const R = halfWidth(rig, pc.at.y)
      let behind = false
      for (let yaw = 0; yaw <= 360; yaw += 5) {
        const ps = piecePose(rig, pc, { ...still, yaw, wl: 1.5, wr: 1.5 }, newPose())
        const x = pc.at.x + ps.dx
        expect(Math.abs(x - rig.cx), `${pc.id} @ ${yaw}°`).toBeLessThan(R)
        if (ps.depth < 0) behind = true
      }
      expect(behind, `${pc.id} 转到背面`).toBe(true)
    }
  })

  it('翅膀转过正面会翻到另一侧(❌ 一直朝原来的方向伸着)', () => {
    const wing = rig.pieces.find((p) => p.kind === 'wing' && p.side < 0)!
    const front = piecePose(rig, wing, still, newPose()).m[0]
    // 左翅的角度是负的:转过 phi = 0(正对镜头)以后,向外伸的方向反过来
    const phi0 = Math.asin((wing.at.x - rig.cx) / (halfWidth(rig, wing.at.y) - 12)) * (180 / Math.PI)
    const past = piecePose(rig, wing, { ...still, yaw: -phi0 + 30 }, newPose()).m[0]
    expect(Math.sign(front)).toBe(1)
    expect(Math.sign(past)).toBe(-1)
  })

  it('翅膀抬起时它压在身上的接触阴影淡掉', () => {
    const wing = rig.pieces.find((p) => p.kind === 'wing')!
    expect(piecePose(rig, wing, still, newPose()).shade).toBeGreaterThan(0)
    expect(piecePose(rig, wing, still, newPose()).shade).toBeLessThan(0.5)
    expect(piecePose(rig, wing, { ...still, wl: 1, wr: 1 }, newPose()).shade).toBe(0)
  })

  it('肩部在半抬和抬起时遮住翅根,静止、背面和肩外都不加覆盖', () => {
    for (const wing of rig.pieces.filter((p) => p.kind === 'wing')) {
      const ps = piecePose(rig, wing, still, newPose())
      expect(shoulderCover(wing, ps, 0, wing.at.x, wing.at.y)).toBe(0)
      expect(shoulderCover(wing, ps, -1, wing.at.x, wing.at.y)).toBe(0)
      for (const lift of [0.5, 1]) expect(shoulderCover(wing, ps, lift, wing.at.x, wing.at.y)).toBe(1)
      expect(shoulderCover(wing, { ...ps, depth: -1 }, 1, wing.at.x, wing.at.y)).toBe(0)
      expect(shoulderCover(wing, ps, 1, rig.cx, wing.at.y)).toBe(0)
      expect(shoulderCover(wing, ps, 1, wing.at.x, 850)).toBe(0)
      const early = shoulderCover(wing, ps, 0.025, wing.at.x, wing.at.y)
      expect(early).toBeGreaterThan(0)
      expect(early).toBeLessThan(0.05)
      const border = wing.at.x + wing.box.w * 0.875
      expect(shoulderCover(wing, ps, 1, border, wing.at.y)).toBeCloseTo(0.5)
    }
  })
})
