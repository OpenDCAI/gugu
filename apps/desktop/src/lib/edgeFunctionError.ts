/**
 * `functions.invoke` 失败时，云函数自己回的那句(响应体的 `{ error }`);读不到才用传输层的那句
 * (「Edge Function returned a non-2xx status code」这类)。单独一个文件、不放进 lib/supabase.ts:那边一 import 就建客户端,
 * 这里是纯函数。
 */
export async function edgeFunctionError(error: Error): Promise<string> {
  try {
    const context = (error as { context?: Response }).context
    const body = context && typeof context.json === 'function' ? await context.json() : null
    if (body?.error) return String(body.error)
  } catch {
    /* 响应体不是 JSON:用传输层的那句 */
  }
  return error.message
}
