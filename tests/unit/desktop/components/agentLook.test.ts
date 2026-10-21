import { describe, expect, it } from 'vitest'
import { BODY_COLORS, REST_FACES, agentIdentity } from '@/components/agentAvatar/engine/identity'
import {
  ALL_REST_FACES,
  BOLD_REST_FACES,
  buildLookUrl,
  colorSlug,
  isLookAvatar,
  lookObjectPath,
  parseAgentLook,
  pickDistinctLook,
  planBirthLooks,
  resolveAgentLook,
  type AgentLook,
} from '@/components/agentAvatar/look'
import { agentLookPoster } from '@/components/agentAvatar/posters'
import { managedAgentAvatarPath } from '@/lib/agentAvatar'
import { displayAvatarUrl } from '@/lib/dicebearAvatar'

const HOST = 'https://devdb.example.space/storage/v1/object/public/avatars'
const lookUrl = (look: AgentLook, host = HOST) => buildLookUrl(`${host}/${lookObjectPath(look.color)}`, look.rest)

/** 可复现的伪随机(mulberry32;测试要确定,产品里用 Math.random)。 */
function seeded(seed: number) {
  let a = (seed + 0x9e3779b9) >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
}

describe('形象地址(颜色 + 休息表情存进头像字段)', () => {
  it('12 色 × 16 种休息表情,写进去什么读出来什么', () => {
    for (let color = 0; color < BODY_COLORS.length; color++) {
      for (const rest of ALL_REST_FACES) {
        const url = lookUrl({ color, rest })
        expect(url).toBe(`${HOST}/agent-look/v1/${colorSlug(color)}.webp?rest=${rest}`)
        expect(parseAgentLook(url)).toEqual({ color, rest })
        expect(isLookAvatar(url)).toBe(true)
      }
    }
  })

  it('只认路径尾巴,不认主机:同一个形象在哪套环境都读得出来', () => {
    const look = { color: 5, rest: 'shy' } as const
    for (const host of [HOST, 'https://db.gugu.example/storage/v1/object/public/avatars', 'http://127.0.0.1:54321/storage/v1/object/public/avatars']) {
      expect(parseAgentLook(lookUrl(look, host))).toEqual(look)
    }
    expect(parseAgentLook(`${lookUrl(look)}&v=2#x`)).toEqual(look)
  })

  it('照片、空、认不出的颜色 / 表情、引擎内部表情都不是形象', () => {
    for (const bad of [
      null,
      undefined,
      '',
      `${HOST}/owner.agent-1.png`,
      `${HOST}/agent-look/v1/cream.webp`,
      `${HOST}/agent-look/v1/cream.webp?rest=woe`,
      `${HOST}/agent-look/v1/cream.webp?rest=asleep`,
      `${HOST}/agent-look/v1/gold.webp?rest=happy`,
      `${HOST}/agent-look/v2/cream.webp?rest=happy`,
    ]) {
      expect(parseAgentLook(bad), String(bad)).toBeNull()
    }
  })

  it('存了形象就按存的,没存(或是照片)按 id 推', () => {
    const id = '1f2e3d4c-5b6a-4789-8abc-def012345678'
    const look = { color: 9, rest: 'excited' } as const
    expect(resolveAgentLook(id, lookUrl(look))).toEqual(look)
    expect(resolveAgentLook(id, null)).toEqual(agentIdentity(id))
    expect(resolveAgentLook(id, `${HOST}/owner.${id}.png`)).toEqual(agentIdentity(id))
  })

  it('手选 16 种 = 日常 6 种 + 个性 10 种,不重不漏', () => {
    expect(ALL_REST_FACES).toHaveLength(16)
    expect(new Set([...REST_FACES, ...BOLD_REST_FACES])).toEqual(new Set(ALL_REST_FACES))
    expect(BOLD_REST_FACES).toHaveLength(10)
  })
})

describe('形象地址不归任何一只 agent 管', () => {
  it('换形象 / 换照片时不去删共用的定格图;上传的照片照旧清理', () => {
    expect(managedAgentAvatarPath(lookUrl({ color: 3, rest: 'happy' }))).toBeNull()
    expect(managedAgentAvatarPath(`${HOST}/owner.agent-1-nonce.png`)).toBe('owner.agent-1-nonce.png')
  })

  it('这个客户端认不出的形象地址(新版本的表情、缺 ?rest=、别的版本)也照样是共用的,❌ 删', () => {
    for (const shared of [
      `${HOST}/agent-look/v1/cream.webp`,
      `${HOST}/agent-look/v1/cream.webp?rest=some-future-face`,
      `${HOST}/agent-look/v1/gold.webp?rest=happy`,
      `${HOST}/agent-look/v2/cream.webp?rest=happy`,
      `${HOST}/agent-look/v1/cream.webp#x`,
    ]) {
      expect(managedAgentAvatarPath(shared), shared).toBeNull()
    }
  })

  it('<img> 场景画这个颜色的本地定格,❌ 去加载那个地址', () => {
    const look = { color: 7, rest: 'curious' } as const
    for (const kind of ['agent', 'human'] as const) {
      expect(displayAvatarUrl(lookUrl(look), 'agent-1', 'test', kind)).toBe(agentLookPoster(look, 'agent-1'))
    }
    expect(displayAvatarUrl(null, 'agent-1', 'test', 'agent')).toBe(agentLookPoster(agentIdentity('agent-1'), 'agent-1'))
  })
})

describe('骰子:挑一个和兄弟尽量不撞的形象', () => {
  it('有没人用的颜色就只在没人用的里挑,且一定换个样', () => {
    const taken: AgentLook[] = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((color) => ({ color, rest: 'neutral' }))
    const current: AgentLook = { color: 9, rest: 'happy' }
    for (let i = 0; i < 200; i++) {
      const look = pickDistinctLook(taken, current, seeded(i))
      expect([10, 11]).toContain(look.color)
      expect(look.rest).not.toBe('happy')
      expect(REST_FACES).toContain(look.rest)
    }
  })

  it('12 色都被用了 → 在用得最少的颜色里挑,表情避开同色兄弟', () => {
    const taken: AgentLook[] = BODY_COLORS.map((_, color) => ({ color, rest: 'neutral' as const }))
    taken.push({ color: 0, rest: 'happy' }, { color: 1, rest: 'curious' })
    for (let i = 0; i < 200; i++) {
      const look = pickDistinctLook(taken, null, seeded(i))
      expect(look.color).toBeGreaterThanOrEqual(2)
      expect(look.rest).not.toBe('neutral')
    }
  })

  it('骰出来的颜色在可选的几格里都会出现(是随机,不是固定落点)', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 400; i++) seen.add(pickDistinctLook([], { color: 0, rest: 'neutral' }, seeded(i)).color)
    expect(seen.size).toBe(BODY_COLORS.length - 1)
  })
})

describe('出生定形象', () => {
  const ids = Array.from({ length: 12 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
  const at = (i: number) => `2026-10-${String(1 + i).padStart(2, '0')}T00:00:00Z`

  it('12 只以内:人人有形象,颜色两两不同', () => {
    const plan = planBirthLooks(ids.map((id, i) => ({ id, avatar: null, created_at: at(i) })), seeded(1))
    expect(plan.map((p) => p.id).sort()).toEqual([...ids].sort())
    expect(new Set(plan.map((p) => p.look.color)).size).toBe(12)
  })

  it('能保留按 id 推出来的样子就保留(先出生的先占),撞了才换', () => {
    const first = ids[0]
    const plan = planBirthLooks([{ id: first, avatar: null, created_at: at(0) }], seeded(2))
    expect(plan).toEqual([{ id: first, look: agentIdentity(first) }])

    // 第二只按 id 推出来的颜色和第一只一样 → 它得换;第一只(先出生)不动
    const clash = ids.find((id) => id !== first && agentIdentity(id).color === agentIdentity(first).color)
      ?? Array.from({ length: 500 }, (_, i) => `clash-${i}`).find((id) => agentIdentity(id).color === agentIdentity(first).color)!
    const two = planBirthLooks(
      [
        { id: clash, avatar: null, created_at: at(5) },
        { id: first, avatar: null, created_at: at(0) },
      ],
      seeded(3),
    )
    expect(two[0]).toEqual({ id: first, look: agentIdentity(first) })
    expect(two[1].id).toBe(clash)
    expect(two[1].look.color).not.toBe(agentIdentity(first).color)
  })

  it('已经有形象的不动、也占着颜色;传了照片的不定形象、也不占颜色', () => {
    const stored: AgentLook = { color: agentIdentity(ids[1]).color, rest: 'shy' }
    const plan = planBirthLooks(
      [
        { id: 'has-look', avatar: lookUrl(stored), created_at: at(0) },
        { id: 'has-photo', avatar: `${HOST}/owner.has-photo-1.png`, created_at: at(0) },
        { id: ids[1], avatar: null, created_at: at(2) },
      ],
      seeded(4),
    )
    expect(plan.map((p) => p.id)).toEqual([ids[1]])
    expect(plan[0].look.color).not.toBe(stored.color)
  })
})
