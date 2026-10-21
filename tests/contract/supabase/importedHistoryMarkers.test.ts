// 导入历史的标记前缀由库里的导入 RPC 写入、由客户端读取器识别:两边必须逐字一致。RPC 在 gugu-supabase(#6322)。
import { describe, expect, it, vi } from 'vitest'
import { withContractDatabase } from './database'

vi.mock('../../../apps/desktop/src/lib/supabase', () => ({ chatDb: {} }))
const { IMPORTED_HISTORY_ROOT_PREFIX, IMPORTED_HISTORY_TURN_PREFIX } = await import(
  '../../../apps/desktop/src/lib/importedHistoryReader'
)

describe('imported history marker contract', () => {
  it('uses the exact producer markers from the installed four-argument import RPC', async () => {
    const sql = await withContractDatabase(async (db) => {
      const { rows } = await db.query<{ sql: string }>("SELECT pg_get_functiondef('chat.import_agent_session_history(text,text,text,jsonb)'::regprocedure) AS sql")
      return rows[0].sql
    })
    expect(sql).toContain(`'${IMPORTED_HISTORY_ROOT_PREFIX}' || gen_random_uuid()::text`)
    expect(sql).toContain(`'${IMPORTED_HISTORY_TURN_PREFIX}' || gen_random_uuid()::text`)
  })
})
