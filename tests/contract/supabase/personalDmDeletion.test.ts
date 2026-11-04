import { expect, it } from 'vitest'
import { withContractDatabase } from './database'

it('exposes the personal deletion RPC contract only to authenticated callers', async () => {
  await withContractDatabase(async db => {
    const result = await db.query(`SELECT p.proargnames AS names,pg_get_function_result(p.oid) AS result,
      has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
      has_function_privilege('anon',p.oid,'EXECUTE') AS anonymous,
      has_function_privilege('service_role',p.oid,'EXECUTE') AS service
      FROM pg_proc p WHERE p.oid='chat.delete_my_dm_conversation(text)'::regprocedure`)
    expect(result.rows).toEqual([{names:['p_chat_id'],result:'jsonb',authenticated:true,anonymous:false,service:false}])
  })
})

it('allows the client to read personal list state without granting direct mutation of the retained membership', async () => {
  await withContractDatabase(async db => {
    await db.query('BEGIN')
    try {
      await db.query('SET LOCAL ROLE authenticated')
      await db.query('SELECT conversation_deleted_at FROM chat.active_members WHERE false')
      const result = await db.query(`SELECT has_column_privilege('authenticated','chat.chat_members','conversation_deleted_at','UPDATE') AS allowed`)
      expect(result.rows).toEqual([{allowed:false}])
    } finally { await db.query('ROLLBACK') }
  })
})
