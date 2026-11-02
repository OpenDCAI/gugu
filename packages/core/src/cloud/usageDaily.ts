import type { SupabaseClient } from '@supabase/supabase-js'
import type { UsageDailyRow } from '../shared/usage/rows'

export type UsageRowsClient = Pick<SupabaseClient, 'from'>

function fail(error: { message: string } | null): never {
  throw new Error(error?.message ?? 'unknown error')
}

const UPSERT_CHUNK = 500
const READ_PAGE = 500

/**
 * 把这台设备 [from, to] 这段的云端行替换成本机这一次算出来的样子:先 upsert,再删掉这段里
 * 本机已经没有的 (day, engine) —— 否则某天的数据被重算成 0 后,云端会永远留着旧数字。
 */
export async function replaceUsageDeviceRows(client: UsageRowsClient, rows: UsageDailyRow[], deviceId: string, from: string, to: string): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const { error } = await client
      .from('usage_daily')
      .upsert(rows.slice(i, i + UPSERT_CHUNK), { onConflict: 'user_id,device_id,day,engine' })
    if (error) fail(error)
  }
  const keep = new Set(rows.map((r) => `${r.day}|${r.engine}`))
  // 分页取:PostgREST 每次最多回 max-rows 行,首次同步 400 天 × 几家引擎会超过它;一次取完会静默截断,
  // 截掉的那部分陈旧行就永远删不掉。
  const existing: { day: string; engine: string }[] = []
  for (let offset = 0; ; offset += READ_PAGE) {
    const { data, error } = await client
      .from('usage_daily')
      .select('day, engine')
      .eq('device_id', deviceId)
      .gte('day', from)
      .lte('day', to)
      .order('day')
      .order('engine')
      .range(offset, offset + READ_PAGE - 1)
    if (error) fail(error)
    existing.push(...(data ?? []))
    if (!data || data.length < READ_PAGE) break
  }
  const stale = existing.filter((r) => !keep.has(`${r.day}|${r.engine}`))
  for (const r of stale) {
    const { error: delError } = await client
      .from('usage_daily')
      .delete()
      .eq('device_id', deviceId)
      .eq('day', r.day)
      .eq('engine', r.engine)
    if (delError) fail(delError)
  }
}
