// @@@4891 「错误 → 用户文案」的第二段:**渲染边界**。第一段(纯分类)在
// `@gugu/core/shared/supabaseFailure`,它够不到 i18n,所以只产出稳定 kind。
//
// 这一段回答的是「这一类该对用户说哪句话」。规矩来自 product spec
// 「提示条与日志的分工」:
//   · 提示条只承载用户能用上的事实 —— 判据是「删掉这句,他少知道了哪一个他能用上的事实」;
//   · 删掉的东西不是丢弃,是换地方 —— 原始报错一律挂 Error.cause,进日志。
//
// ⚠️ 只有**用户真能据此做点什么**的 kind 才配一句自己的话(网络断了→检查网络;没权限→别再试了)。
// 其余一律回落到调用方给的那句业务文案(「删除联系人失败」),❌ 不发明「后端契约错误」这种
// 用户读不懂也做不了的句子。

import { classifySupabaseFailure, type SupabaseFailure } from '@gugu/core/shared/supabaseFailure'
import { i18n } from '../i18n'

/** 携带分类结果的错误。`message` 面向用户,`cause` 留给日志与排查。 */
export class UserFacingError extends Error {
  readonly failure: SupabaseFailure

  constructor(message: string, failure: SupabaseFailure, cause: unknown) {
    super(message, { cause })
    this.name = 'UserFacingError'
    this.failure = failure
  }
}

/**
 * kind → 用户能用上的那句话;认不出来就回落到调用方的业务文案。
 *
 * `fallback` 是调用方对**这次操作**的说法(「删除联系人失败」),比任何通用句子都具体,
 * 所以它是默认答案 —— 只有当 kind 本身带来了用户能据此行动的信息时才盖过它。
 */
export function describeSupabaseFailure(failure: SupabaseFailure, fallback: string): string {
  switch (failure.kind) {
    case 'offline':
      // 唯一一类用户自己动手就能修的。
      return i18n.t('errors.offline', { ns: 'common' })
    case 'permission-denied':
      // 说清楚「再试也没用」,否则用户会反复点。
      return i18n.t('errors.permissionDenied', { ns: 'common' })
    case 'duplicate':
    case 'not-found':
    case 'backend-contract':
    case 'unknown':
      // 这三类对用户是同一件事:这次没成。具体是哪一步没成,调用方的 fallback 比这里清楚。
      return fallback
  }
}

/**
 * 把后端错误转成一个可以直接抛给 UI 的错误:`message` 是用户看得懂的那句,原文进 `cause`。
 *
 * 用法(数据层):
 * ```ts
 * if (error) throw toUserFacingError(error, t('contacts.removeFailed'))
 * ```
 */
export function toUserFacingError(error: unknown, fallback: string): UserFacingError {
  const failure = classifySupabaseFailure(error)
  return new UserFacingError(describeSupabaseFailure(failure, fallback), failure, error)
}

/**
 * UI 侧:拿到一个 catch 来的东西,给出该显示的那句话。
 *
 * ❌ 别再写 `error instanceof Error ? error.message : t('xxx')` —— 那个三元式把写好的业务文案
 * 降级成了几乎不触发的兜底分支,用户平时看到的是裸的 PostgREST 英文串(#4891 审计里 5 处)。
 */
export function messageForUser(error: unknown, fallback: string): string {
  // ⚠️ 已经是 UserFacingError 时也**重新按 fallback 描述一次**,不能直接取 error.message ——
  // 数据层给的是通用兜底(「操作失败」),而 UI 知道用户刚才在干什么(「删除联系人失败」),后者更具体。
  // 只有 offline / permission-denied 这两类自带用户能用上的信息,才会盖过 fallback。
  const failure = error instanceof UserFacingError ? error.failure : classifySupabaseFailure(error)
  return describeSupabaseFailure(failure, fallback)
}
