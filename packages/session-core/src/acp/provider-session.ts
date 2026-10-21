import { z } from 'zod'

export const providerSessionStateSchema = z.enum(['missing', 'restart_failed'])
export type ProviderSessionState = z.infer<typeof providerSessionStateSchema>

const CODEX_MISSING_ROLLOUT_CODE = -32600
const ACP_INTERNAL_ERROR_CODE = -32603
const ACP_INTERNAL_ERROR_MESSAGE = 'Internal error'
const CODEX_MISSING_ROLLOUT_MESSAGE =
  /^no rollout found for thread id [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * ACP 的 resource-not-found。claude-agent-acp(实测 0.54.1)对一条引擎侧不存在的会话
 * `session/load` 就回这个码,文案 `Resource not found`。
 *
 * 这里**只认码、不匹配文案**,与上面 codex 那条的严格程度不同,是因为两者的码不是一回事:
 * `-32600` 是 JSON-RPC 的通用 invalid request,什么都可能是它,所以必须配文案才敢下结论;
 * `-32002` 在 ACP 里就是「这个资源不存在」,而这个判据**只在「我们刚要 resume 一条既有会话」
 * 的那几处被问到**(session/load 的 catch、pty spawn 的 catch)—— 在那个语境下,
 * 「资源不存在」没有第二种读法。
 *
 * ❌ 别把它退回成 codex 专属:漏掉这一条时,claude 的 loadSession 失败会掉进
 * 「warn 一句、默默 newSession」那条降级路,用户最后看到的是 `ACP connection closed` ——
 * 一条本可以照首轮重来的会话,变成了没有出路的死会话(spec session-resume 底线)。
 */
const ACP_RESOURCE_NOT_FOUND_CODE = -32002

/**
 * 目前实测过永久性「会话不在了」的两家:codex 与 claude。
 *
 * **必须交出正在恢复的那条 provider session id** —— 这不是装饰参数,是把上面那条注释里的
 * 「只在 resume 语境下被问到」从自我担保变成结构约束:`-32002` 是通用的「资源不存在」,只有
 * 「我刚拿着一条**既有**会话去 load」这个语境才让它没有第二种读法。手上没有 id 的调用方
 * (新建会话、首次 spawn)压根问不出这个问题,也就不可能把「从来没有过」判成「已不存在」——
 * 那会让一条崭新的会话弹出「照第一句话重来」,对用户是一句假话。
 */
export function isProviderSessionMissingError(
  error: unknown,
  context: { resumingProviderSessionId: string }
): boolean {
  if (!context.resumingProviderSessionId) return false
  return isProviderSessionMissingErrorInner(error, new Set())
}

function isProviderSessionMissingErrorInner(error: unknown, seen: Set<object>): boolean {
  if (typeof error !== 'object' || error === null || seen.has(error)) return false
  seen.add(error)

  const value = error as { code?: unknown; message?: unknown; cause?: unknown; data?: unknown }
  const message = typeof value.message === 'string' ? value.message.trim() : null
  if (
    value.code === CODEX_MISSING_ROLLOUT_CODE &&
    message !== null &&
    CODEX_MISSING_ROLLOUT_MESSAGE.test(message)
  ) {
    return true
  }

  if (value.code === ACP_RESOURCE_NOT_FOUND_CODE) {
    return true
  }

  const data = value.data as { details?: unknown } | null
  if (
    value.code === ACP_INTERNAL_ERROR_CODE &&
    message === ACP_INTERNAL_ERROR_MESSAGE &&
    typeof data?.details === 'string' &&
    CODEX_MISSING_ROLLOUT_MESSAGE.test(data.details.trim())
  ) {
    return true
  }

  if (message?.startsWith('{')) {
    try {
      const parsed = JSON.parse(message) as unknown
      if (isProviderSessionMissingErrorInner(parsed, seen)) return true
    } catch {
      // Provider error messages do not otherwise need to be JSON.
    }
  }

  return isProviderSessionMissingErrorInner(value.cause, seen)
}
