// @@@4891 「错误 → 用户文案」的第一段:**纯分类**。
//
// 为什么要分两段:提示条只承载用户能用上的事实(product spec「提示条与日志的分工」),
// 而判断「这个错属于哪一类」和「这一类该说哪句话」是两件事 —— 前者是数据层的语义,后者要读 locale。
// packages/core 够不到 i18n(i18n 单例依赖 window/localStorage,主进程与 core 都没有),所以这一段
// 只产出稳定 kind,不成句、不读 locale。渲染那一段在 apps/desktop 侧。
//
// 这个形状仓里已经验证过一次:task 侧 `fetchErrorFailure`(纯分类)+ `describeGitFetchFailure`(kind→文案)。
// 照抄它,❌ 不另立架构。
//
// ⚠️ 这里**不做**「把原始报错藏起来」这件事 —— 原文一律经调用方挂进 Error.cause,进日志。
// 藏的是「给用户看」,不是「记下来」;两者混为一谈,排查就没有依据了。

/** Postgres / PostgREST 错误码。仓里此前没有任何常量表,只有一处硬写的 '23505'(contacts.ts)。 */
export const PG_ERROR_CODES = {
  /** 唯一约束冲突。 */
  uniqueViolation: '23505',
  /** 外键约束冲突。 */
  foreignKeyViolation: '23503',
  /** 非空约束冲突。 */
  notNullViolation: '23502',
  /** 权限不足 —— RLS 拒绝也走这个码。 */
  insufficientPrivilege: '42501',
  /** PostgREST:结果集为空,而调用方用了 .single()。 */
  singleRowExpected: 'PGRST116',
  /** PostgREST:schema cache 里找不到这个函数(RPC 名写错 / 迁移没跑)。 */
  functionNotFound: 'PGRST202',
} as const

export type SupabaseFailureKind =
  /** 这条记录已经存在(重复好友申请、重复加群…)。用户能理解,也做得了事。 */
  | 'duplicate'
  /** 没有权限做这件事 —— 含 RLS 拒绝。 */
  | 'permission-denied'
  /** 要找的东西不在。 */
  | 'not-found'
  /** 网络没通。用户唯一真正能自己动手修的一类。 */
  | 'offline'
  /** 后端契约不对(RPC 缺失、迁移没跑)。用户做不了任何事,只该显示通用文案 + 进日志。 */
  | 'backend-contract'
  /** 认不出来。默认档:通用文案 + 原文进日志。 */
  | 'unknown'

export interface SupabaseFailure {
  kind: SupabaseFailureKind
  /** 原始错误码(有的话),只用于日志与判定,❌ 不渲染给用户。 */
  code?: string
}

/** PostgREST 的错误对象形状:{ message, details, hint, code }。这里只做鸭子类型判定,不引 supabase-js。 */
function readCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

function readMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const m = (error as { message?: unknown }).message
    if (typeof m === 'string') return m
  }
  return String(error ?? '')
}

/**
 * 把一个后端错误分到稳定 kind。纯函数:不读 locale、不认识 catalog、不产出句子。
 *
 * 分流优先认**错误码**(精确、不随文案漂);只有没有码时才退到文本特征 —— 那是最后一招,
 * 因为上游改一个词就会让子串匹配悄悄失效。
 */
export function classifySupabaseFailure(error: unknown): SupabaseFailure {
  const code = readCode(error)
  if (code) {
    switch (code) {
      case PG_ERROR_CODES.uniqueViolation:
        return { kind: 'duplicate', code }
      case PG_ERROR_CODES.insufficientPrivilege:
        return { kind: 'permission-denied', code }
      case PG_ERROR_CODES.singleRowExpected:
        return { kind: 'not-found', code }
      case PG_ERROR_CODES.functionNotFound:
        return { kind: 'backend-contract', code }
      case PG_ERROR_CODES.foreignKeyViolation:
      case PG_ERROR_CODES.notNullViolation:
        return { kind: 'backend-contract', code }
      default:
        break
    }
  }

  const text = readMessage(error).toLowerCase()
  // RLS 拒绝在有些路径上不带 42501,只有这句文案 —— #4891 审计里 CreateAgentModal 的正则
  // 正是漏了它(只认 constraint/duplicate key),于是 RLS 报错连表名一起透给了用户。
  if (text.includes('row-level security') || text.includes('permission denied')) {
    return { kind: 'permission-denied', code }
  }
  if (text.includes('violates unique constraint') || text.includes('duplicate key')) {
    return { kind: 'duplicate', code }
  }
  if (text.includes('failed to fetch') || text.includes('networkerror') || text.includes('err_internet_disconnected')) {
    return { kind: 'offline', code }
  }
  if (text.includes('schema cache') || text.includes('does not exist')) {
    return { kind: 'backend-contract', code }
  }
  return { kind: 'unknown', code }
}
