import type { RuntimeAuth } from '@gugu/core'

export type InboxKickLog = { warn: (fields: Record<string, unknown>, message: string) => void }

/**
 * 读者触发的那一脚(见 main.ts `kickInboxForAgent`):先拿登录态,拿到了再交给 `kick` 拉一次收件箱。
 *
 * 调用方一律不等它(开机扫、唤醒完成、回合结束……都是 fire-and-forget),所以收尾在这里:拿不到登录态
 * —— 没登录、续期被拒(`RuntimeAuthExpiredError`)、登录服务这一下没答上来 —— 只记一行 warn 就算了,
 * ❌ 漏成「未处理的 Promise 拒绝」。#7225:server 的续期令牌作废后开机,开机扫对每个 agent 踢这一脚,
 * `getAuth()` 第一次调用抛 `RuntimeAuthExpiredError`,从前就这样漏出去。登出与退出照旧归 `onAuthExpired`。
 */
export function kickInboxWhenAuthed(input: {
  agentUserId: string
  trigger: string
  getAuth: () => Promise<RuntimeAuth | null> | undefined
  kick: (auth: RuntimeAuth) => void
  onFailure?: (error: unknown) => void
  log: InboxKickLog
}): Promise<void> {
  const { agentUserId, trigger, log } = input
  const reason = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  return (async () => {
    let auth: RuntimeAuth | null | undefined
    try {
      auth = await input.getAuth()
    } catch (error) {
      input.onFailure?.(error)
      log.warn({ agentUserId, trigger, err: reason(error) }, 'skip inbox kick: auth unavailable')
      return
    }
    if (!auth?.accessToken || !auth.userId) {
      log.warn({ agentUserId, trigger }, 'skip inbox kick: host is not authenticated')
      return
    }
    // 登着、却在装依赖 / 交给读者那一步抛了:另记一句 —— ❌ 说成登录问题,排查收件箱卡住的人会去查错地方。
    try {
      input.kick(auth)
    } catch (error) {
      input.onFailure?.(error)
      log.warn({ agentUserId, trigger, err: reason(error) }, 'inbox kick failed')
    }
  })()
}
