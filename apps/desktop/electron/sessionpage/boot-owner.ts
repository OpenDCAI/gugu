/**
 * #5025 开机时「当前登录的是谁」的唯一取法。
 *
 * 老写法是 `Promise.race([getAuth(), 计时器(ms)])`。它的缺陷不在时长上:渲染进程在 session 恢复落地前
 * 会**立刻**回一个 `null`,race 于是在几十毫秒内就以 `null` 结束,不管 `ms` 写的是 3 秒还是 60 秒。
 * 而下游 `agentMayBelongTo(row, null)` 把 `null` 读作「不知道 ⇒ 全放行」,归属过滤就此静默失效。
 * ⇒ 把 `ms` 调大治不了这个:答案 1.7 秒就回来了,只是答错了。
 *
 * 这里改成问一个**会区分「还不知道」和「没登录」**的问题(渲染侧 `getSessionOwner`),并且:
 *   · 只有 `decided` 为真才算答案;
 *   · 整体不超过调用方给的预算 —— 路由等着这份结果,❌ 让它干等;
 *   · 预算内没等到答案 ⇒ 返回 `null`(未知),沿用调用方原有的宽松兜底。
 *     兜底方向是**有意的**:漏注册自己的行会让投递掉到原生引擎去 spawn 进程,比多注册别家的行
 *     (只是内存路由表里一条死记录 + 收件扫描多几行 400)危险得多。
 */

/** 单次 IPC 的驻留上限。渲染命令通道自身 30s 超时,越过它对面会先超时,反而拿不到答案。 */
const ASK_CHUNK_MS = 20_000

export type BootOwnerAnswer = { decided?: boolean; userId?: string | null } | null

export type BootOwnerAsk = (waitMs: number) => Promise<BootOwnerAnswer>

/**
 * 在 `budgetMs` 内拿一个**定了的**归属答案。
 * @returns 已登录 → userId;已确定没人登录 → `null`;预算内仍未定 → `null`(与「没登录」在返回值上同形,
 *          因为两者的兜底一致:都不该按某个账号去过滤。区分只在 ask 那一层需要,这里不再传播。)
 */
export async function resolveBootOwner(ask: BootOwnerAsk, budgetMs: number): Promise<string | null> {
  const deadline = Date.now() + budgetMs
  const poll = async (): Promise<string | null> => {
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return null
      let answer: BootOwnerAnswer
      try {
        answer = await ask(Math.min(remaining, ASK_CHUNK_MS))
      } catch {
        // 传输坏了(窗口还没建/已销毁)也是「不知道」。❌ 别重试到把路由拖死。
        return null
      }
      if (answer?.decided) return answer.userId ?? null
    }
  }
  // 外层闸:ask 在渲染进程就绪前会先等就绪,那一等有它自己的 30s 预算,可能远超我们的。
  // 路由等着这份结果,所以预算到点就必须交卷。
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), budgetMs) })
  return Promise.race([poll(), budget]).finally(() => { if (timer !== undefined) clearTimeout(timer) })
}
