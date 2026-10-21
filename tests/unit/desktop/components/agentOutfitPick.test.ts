import { describe, expect, it } from 'vitest'
import { BODY_COLORS, hash32 } from '@/components/agentAvatar/engine/identity'
import { OUTFIT_BY_ID, clashes } from '@/components/agentAvatar/engine/outfitCatalog'
import { DERIVE_V1, ROLL_RULES, blendsWithBody, defaultWear, pickWear } from '@/components/agentAvatar/engine/outfitPick'

const { accentChance: ACCENT_CHANCE, excluded: CLIPPING_PAIRS, pool: MAIN_POOL } = ROLL_RULES
import { rollLook, rollWear, wornOf, type AgentLook } from '@/components/agentAvatar/look'

/** 可复现的伪随机(mulberry32) */
function seeded(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const DIY_ONLY = ['sunglasses', 'cape', 'backpack', 'skateboard', 'umbrella']

describe('随机抽一身(owner 10-19:好看、不要太复杂)', () => {
  const rng = seeded(7)
  const draws = Array.from({ length: 12000 }, (_, i) => ({ color: i % BODY_COLORS.length, wear: pickWear(i % BODY_COLORS.length, rng, ROLL_RULES, { month: 4 }) }))

  it('至少一件、最多两件;两件不打架,也不是穿模检查排掉的组合', () => {
    for (const { wear } of draws) {
      expect(wear.length).toBeGreaterThanOrEqual(1)
      expect(wear.length).toBeLessThanOrEqual(2)
      if (wear.length === 2) {
        expect(clashes(OUTFIT_BY_ID.get(wear[0].id)!, OUTFIT_BY_ID.get(wear[1].id)!)).toBe(false)
        expect(CLIPPING_PAIRS.some(([a, b]) => (a === wear[0].id && b === wear[1].id) || (a === wear[1].id && b === wear[0].id))).toBe(false)
      }
    }
  })

  it('两件的比例在 15–20%(大多数只有一件主件)', () => {
    const two = draws.filter((d) => d.wear.length === 2).length / draws.length
    expect(two).toBeGreaterThan(0.15)
    expect(two).toBeLessThan(0.2)
    expect(ACCENT_CHANCE).toBeGreaterThanOrEqual(0.15)
    expect(ACCENT_CHANCE).toBeLessThanOrEqual(0.2)
  })

  it('复杂件(墨镜、披风、背包、滑板、雨伞)只给 DIY,不进随机;非 12 月没有圣诞帽', () => {
    const ids = new Set(draws.flatMap((d) => d.wear.map((w) => w.id)))
    for (const id of DIY_ONLY) expect(ids.has(id), id).toBe(false)
    expect(ids.has('santahat')).toBe(false)
  })

  it('主件按类别抽:套装 35 / 头上 45 / 其它 20(每类允许 ±3 个百分点)', () => {
    const share = (ids: readonly string[]) => draws.filter((d) => ids.includes(d.wear[0].id)).length / draws.length
    expect(Math.abs(share(MAIN_POOL[0].ids) - 0.35)).toBeLessThan(0.03)
    expect(Math.abs(share(MAIN_POOL[1].ids) - 0.45)).toBeLessThan(0.03)
    expect(Math.abs(share([...MAIN_POOL[2].ids, ...MAIN_POOL[3].ids]) - 0.2)).toBeLessThan(0.03)
  })

  it('配色不会融进身体;轻套装也抽到了换过的配色', () => {
    for (const { color, wear } of draws)
      for (const w of wear) expect(blendsWithBody(OUTFIT_BY_ID.get(w.id)!.colorways[w.cw].swatch, color), `${w.id}.${w.cw} on ${color}`).toBe(false)
    expect(draws.some((d) => d.wear[0].id.startsWith('set-') && d.wear[0].cw > 0)).toBe(true)
  })

  it('融进身体的判据能判出来:抹茶身体配抹茶色毛线帽算融进去,深棕熊耳朵在奶油身上不算', () => {
    const matcha = BODY_COLORS.findIndex((c) => c.en === 'Matcha')
    expect(blendsWithBody('#8fb07a', matcha)).toBe(true)
    expect(blendsWithBody('#9a6a44', 0)).toBe(false)
  })

  it('12 月掷骰子时圣诞帽进头上那一类', () => {
    const r = seeded(3)
    const ids = new Set(Array.from({ length: 4000 }, (_, i) => pickWear(i % 12, r, ROLL_RULES, { month: 11 })[0].id))
    expect(ids.has('santahat')).toBe(true)
  })
})

describe('推导规则 v1 是一份冻结的快照', () => {
  it('v1 里的每件都还在目录里、配色序号都有效;点缀从不和主件打架', () => {
    for (const [id, it] of Object.entries(DERIVE_V1.items)) {
      const def = OUTFIT_BY_ID.get(id)
      expect(def, id).toBeTruthy()
      expect(def!.slot, id).toBe(it.slot)
      expect(def!.colorways.length, id).toBeGreaterThanOrEqual(it.swatches.length)
    }
    for (const g of DERIVE_V1.pool)
      for (const id of g.ids)
        for (const a of DERIVE_V1.accents[DERIVE_V1.items[id].slot] ?? []) expect(clashes(OUTFIT_BY_ID.get(id)!, OUTFIT_BY_ID.get(a)!), `${id}+${a}`).toBe(false)
  })

  /**
   * 钉死一批 id 在 v1 下的默认装扮(2026-10-19 算出)。没存过装扮的鸟永远按 v1 推导:谁原地改了 DERIVE_V1 的表、
   * 判据或推导的种子,这格就红 —— 要改抽法请新开一份规则给 ROLL_RULES,❌ 动 v1。
   */
  it('固定 id 的 v1 推导结果不变', () => {
    const worn = (id: string, color: number) => defaultWear(id, color).map((w) => `${w.id}.${w.cw}`).join(',')
    expect(GOLDEN.map(([id, color]) => [id, color, worn(id, color)])).toEqual(GOLDEN)
    // 24 行看得懂,但对小改动不够灵敏(比如点缀概率 0.18 → 0.2 一行都不变):再钉 2000 只的摘要
    const all = Array.from({ length: 2000 }, (_, i) => worn(`agent-${i}`, i % 12)).join('|')
    expect(hash32(all)).toBe(GOLDEN_DIGEST)
  })
})

describe('默认装扮:按 id 推导,不写库', () => {
  it('同一个 id + 颜色,推几次都是同一身(两台设备算出来一样)', () => {
    for (let i = 0; i < 200; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
      expect(defaultWear(id, i % 12)).toEqual(defaultWear(id, i % 12))
    }
  })

  it('不同的 id 穿得各不一样(主件铺得开);推导不看日期,不会出圣诞帽', () => {
    const mains = new Set<string>()
    for (let i = 0; i < 3000; i++) {
      const w = defaultWear(`agent-${i}`, i % 12)
      mains.add(w[0].id)
      expect(w.some((x) => x.id === 'santahat')).toBe(false)
    }
    expect(mains.size).toBeGreaterThanOrEqual(20)
  })

  it('地址里没有 wear = 按 id 推导;wear= 空 = 不戴;存了的照存的穿', () => {
    const base = { color: 3, rest: 'happy' as const }
    expect(wornOf(base, 'agent-x')).toEqual(defaultWear('agent-x', 3))
    expect(wornOf({ ...base, wear: [] }, 'agent-x')).toEqual([])
    expect(wornOf({ ...base, wear: [{ id: 'crown', cw: 1 }] }, 'agent-x')).toEqual([{ id: 'crown', cw: 1 }])
  })
})

describe('抽法不会抽不出来', () => {
  it('每种身体颜色、每个主件类别里都至少有一件有不融进身体的配色(所以 pickWear 的「抽不出就报错」碰不到)', () => {
    for (let color = 0; color < BODY_COLORS.length; color++)
      for (const rules of [DERIVE_V1, ROLL_RULES])
        for (const g of rules.pool)
          expect(g.ids.some((id) => rules.items[id].swatches.some((sw) => !blendsWithBody(sw, color, rules))), `${color} ${g.ids[0]}`).toBe(true)
  })
})

describe('掷骰子', () => {
  it('兄弟的主件按主件池认,不按它排第几(DIY 搭过的,主件可能排在点缀后面)', () => {
    const head = ROLL_RULES.pool[1].ids
    // 除了小王冠,头上每件都有兄弟戴着,而且都是先戴眼镜再戴帽子(DIY 的顺序)
    const taken: AgentLook[] = head.filter((id) => id !== 'crown').map((id) => ({ color: 0, rest: 'happy', wear: [{ id: 'glasses', cw: 0 }, { id, cw: 0 }] }))
    const script = [0.5, 0, 0, 0.99] // 落在「头上」那一类 → 第一件 → 第一种配色 → 不加点缀
    let i = 0
    const wear = rollWear(4, taken, () => script[Math.min(i++, script.length - 1)], 4)
    expect(wear[0].id).toBe('crown')
  })

  it('结果带着明确的一身;兄弟们的主件尽量不撞', () => {
    const rng = seeded(11)
    const family: AgentLook[] = []
    for (let i = 0; i < 12; i++) {
      const look = rollLook(family, null, rng, 4)
      expect(look.wear?.length).toBeGreaterThan(0)
      family.push(look)
    }
    // 12 只的主件:同一类别里用得最少的先抽,撞车只会发生在类别本身很小的时候(耳机只有一件)
    const mains = family.map((l) => l.wear![0].id)
    const dup = mains.length - new Set(mains).size
    expect(dup).toBeLessThanOrEqual(2)
  })
})

const GOLDEN: [string, number, string][] = [
  ['00000000-0000-4000-8000-000000000000', 0, 'bow.3'],
  ['00000000-0000-4000-8000-000000007919', 5, 'bowtie.2'],
  ['00000000-0000-4000-8000-000000015838', 10, 'headphones.3'],
  ['00000000-0000-4000-8000-000000023757', 3, 'partyhat.1'],
  ['00000000-0000-4000-8000-000000031676', 8, 'tophat.1,scarf.1'],
  ['00000000-0000-4000-8000-000000039595', 1, 'flower.1'],
  ['00000000-0000-4000-8000-000000047514', 6, 'scarf.1'],
  ['00000000-0000-4000-8000-000000055433', 11, 'set-wizard.1'],
  ['00000000-0000-4000-8000-000000063352', 4, 'set-dino.2'],
  ['00000000-0000-4000-8000-000000071271', 9, 'set-frog.0,glasses.1'],
  ['00000000-0000-4000-8000-000000079190', 2, 'bell.0'],
  ['00000000-0000-4000-8000-000000087109', 7, 'beanie.2'],
  ['00000000-0000-4000-8000-000000095028', 0, 'headphones.2'],
  ['00000000-0000-4000-8000-000000102947', 5, 'strawhat.2'],
  ['00000000-0000-4000-8000-000000110866', 10, 'set-bee.0'],
  ['00000000-0000-4000-8000-000000118785', 3, 'set-puppy.0'],
  ['00000000-0000-4000-8000-000000126704', 8, 'set-chef.2'],
  ['00000000-0000-4000-8000-000000134623', 1, 'headphones.2'],
  ['00000000-0000-4000-8000-000000142542', 6, 'set-chef.2'],
  ['00000000-0000-4000-8000-000000150461', 11, 'flower.1'],
  ['00000000-0000-4000-8000-000000158380', 4, 'headphones.2'],
  ['00000000-0000-4000-8000-000000166299', 9, 'set-puppy.2'],
  ['00000000-0000-4000-8000-000000174218', 2, 'bowtie.3'],
  ['00000000-0000-4000-8000-000000182137', 7, 'headphones.1']
]
const GOLDEN_DIGEST = 2579403302
