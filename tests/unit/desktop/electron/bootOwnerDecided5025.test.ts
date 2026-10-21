import { describe, expect, it, vi } from 'vitest'
import { resolveBootOwner, type BootOwnerAnswer } from '../../../../apps/desktop/electron/sessionpage/boot-owner'

const OWNER = '902480e3-a679-4542-a6f9-f403d133dc71'

/**
 * #5025 每条断言都必须能在**老实现**上判红,否则它只是在陈述现状。
 * 老实现 = `Promise.race([getAuth(), 计时器(ms)])`,而 getAuth 在 session 恢复落地前立刻返回 null。
 * 下面用它当阳性对照(`legacyRace`),证明第一条断言真的在抓那个缺陷。
 */
function legacyRace(fastNullMs: number, ms: number): Promise<string | null> {
  return Promise.race([
    new Promise<string | null>((resolve) => setTimeout(() => resolve(null), fastNullMs)),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ])
}

/** 渲染进程:先 N 次回「还没定」,之后回一个定了的答案。 */
function renderer(undecidedRounds: number, final: BootOwnerAnswer) {
  let round = 0
  return vi.fn(async (waitMs: number) => {
    if (round++ < undecidedRounds) {
      // 真实渲染侧在预算内没等到就如实回 decided:false,这里同样消耗掉那段预算。
      await new Promise((resolve) => setTimeout(resolve, waitMs))
      return { decided: false, userId: null }
    }
    return final
  })
}

describe('#5025 开机归属:未定不等于没登录', () => {
  it('渲染进程先说「还没定」、随后定为某账号 → 拿到那个账号', async () => {
    const ask = renderer(1, { decided: true, userId: OWNER })
    // 预算够跑完第一轮(每轮消耗 min(remaining, 20s),这里 remaining 小,所以第一轮就是 40ms)
    expect(await resolveBootOwner((waitMs) => ask(Math.min(waitMs, 40)), 5_000)).toBe(OWNER)
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('阳性对照:老的 race 写法在同一场景下给出 null(这就是 #5025)', async () => {
    // 与上一条只差一个自由度:取归属的实现。渲染进程的行为(先未定、后定为 OWNER)完全相同。
    // 老写法被那个「快速 null」直接终结,预算写 5 秒还是 60 秒都一样。
    expect(await legacyRace(20, 5_000)).toBeNull()
    expect(await legacyRace(20, 60_000)).toBeNull()
  })

  it('确定没人登录 → 立刻返回 null,不再追问', async () => {
    const ask = renderer(0, { decided: true, userId: null })
    expect(await resolveBootOwner(ask, 5_000)).toBeNull()
    expect(ask).toHaveBeenCalledTimes(1)
  })

  // @@@virtual-clock(#6259) — 下面两条断言的是「预算内追问了几轮 / 预算到点交卷」,那是 setTimeout 与
  // Date.now 之间的算术。用真钟时,满载下 30ms 的那一拍可以晚于 120ms 的预算闸触发,于是「只问了一轮」
  // (mac1 16 路并发 1/160 红)。假钟把两者放在同一条时间轴上,判据只剩被测的顺序。
  it('预算内始终未定 → 返回 null,交回调用方的宽松兜底', async () => {
    vi.useFakeTimers()
    try {
      const ask = vi.fn(async (waitMs: number) => {
        await new Promise((resolve) => setTimeout(resolve, waitMs))
        return { decided: false, userId: null } as BootOwnerAnswer
      })
      let settled = false
      const owner = resolveBootOwner((waitMs) => ask(Math.min(waitMs, 30)), 120).finally(() => {
        settled = true
      })
      // 交卷不能晚于预算:路由等着它。
      await vi.advanceTimersByTimeAsync(120)
      expect(settled).toBe(true)
      expect(await owner).toBeNull()
      expect(ask.mock.calls.length).toBeGreaterThan(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('传输报错 → 当作未知返回 null,❌ 不重试到把路由拖死', async () => {
    const ask = vi.fn(async () => { throw new Error('Renderer not ready') })
    expect(await resolveBootOwner(ask, 5_000)).toBeNull()
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('渲染进程一直不回话 → 预算到点仍然交卷', async () => {
    // ask 永不 resolve,模拟「等渲染就绪」那条自带 30s 预算的等待。外层闸必须兜住。
    vi.useFakeTimers()
    try {
      let settled = false
      const owner = resolveBootOwner(() => new Promise<BootOwnerAnswer>(() => {}), 80).finally(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(80)
      expect(settled).toBe(true)
      expect(await owner).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
