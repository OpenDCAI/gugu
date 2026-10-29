import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { agentSessionArchivalRpcArgs } from '@gugu/core/cloud/sessionArchival'
import { parseAgentPresencePayload } from '@gugu/core/cloud/agentPresenceProtocol'
import { deriveAgentReachability } from '@gugu/core/shared/ui/agentConversationStatusModels'
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation'
import { withContractDatabase } from './database'

describe('client and installed backend session archival contract', () => {
  it('uses the client RPC arguments and parses the same archived identity before restoring without replay', async () => withContractDatabase(async (db) => {
    const [owner, agent, device, group, interval, message, fresh] = Array.from({ length: 7 }, randomUUID)
    await db.query('BEGIN')
    try {
      await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
        VALUES($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [owner, `${owner}@archive-contract.invalid`])
      await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform,status)
        VALUES($1,$2,'fixture','fixture','linux','online')`, [device, owner])
      await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id)
        VALUES($1,'agent','Claude 1',$2,$3)`, [agent, owner, device])
      await db.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Archive contract',$2)`, [group, owner])
      await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')`, [group, owner, agent])
      const archiveAt = new Date().toISOString()
      const call = async (archivedAt: string | null, restoredAt: string | null, revision: number) => {
        const args = agentSessionArchivalRpcArgs(agent, device, { operationId: randomUUID(), revision, archivedAt,
          intervals: [{ id: interval, archivedAt: archiveAt, restoredAt }] })
        await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: owner, role: 'authenticated' })])
        await db.query('SET LOCAL ROLE authenticated')
        const entries = Object.entries(args)
        const named = entries.map(([key], i) => `${key} => $${i + 1}`).join(',')
        const values = entries.map(([key, value]) => key === 'p_intervals' ? JSON.stringify(value) : value)
        const result = await db.query(`SELECT identity.set_agent_session_archival(${named}) AS receipt`, values)
        await db.query('RESET ROLE')
        return result.rows[0].receipt
      }
      expect(await call(archiveAt, null, 1)).toMatchObject({ agent_user_id: agent, revision: 1 })
      const payload = (await db.query('SELECT identity.build_agent_presence_payload($1) AS payload', [agent])).rows[0].payload
      const presence = parseAgentPresencePayload(payload)!
      expect(presence.sessionLifecycleRevision).toBe(1)
      expect(presence.sessionArchivedAt).not.toBeNull()
      const reachability = deriveAgentReachability({ accountStatus: presence.accountStatus, desiredStatus: presence.desiredStatus,
        sessionArchivedAt: presence.sessionArchivedAt, deviceOnline: true })
      expect(presentAgentStatus({ reachability, reading: { status: 'working', detail: 'running' } }))
        .toEqual({ label: 'archived', tone: 'archived', animate: false, emphasis: false })
      await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,to_user_ids)
        VALUES($1,$2,$3,'Archived marker',$4)`, [message, group, owner, [agent]])
      expect((await db.query('SELECT reason FROM chat.message_agent_delivery_blocks WHERE message_id=$1', [message])).rows)
        .toEqual([{ reason: 'agent_archived' }])
      await call(null, new Date().toISOString(), 2)
      await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,to_user_ids)
        VALUES($1,$2,$3,'Restored marker',$4)`, [fresh, group, owner, [agent]])
      await db.query('SET LOCAL ROLE authenticated')
      expect((await db.query('SELECT id FROM identity.pull_agent_inbox_v2($1)', [agent])).rows).toEqual([{ id: fresh }])
      await db.query('RESET ROLE')
      expect((await db.query('SELECT id,display_name,session_archived_at FROM identity.users WHERE id=$1', [agent])).rows)
        .toEqual([{ id: agent, display_name: 'Claude 1', session_archived_at: null }])
      expect((await db.query('SELECT count(*)::int AS n FROM chat.chat_members WHERE chat_id=$1', [group])).rows[0].n).toBe(2)
      await db.query('SET CONSTRAINTS ALL IMMEDIATE')
    } finally { await db.query('ROLLBACK') }
  }))
})
