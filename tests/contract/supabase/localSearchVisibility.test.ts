import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { SEARCH_SCHEMA_SQL } from '../../../packages/core/src/shared/search/schema'
import { buildSearchSql } from '../../../packages/core/src/shared/search/sql'
import { searchTimestampMicros } from '../../../packages/core/src/shared/search/time'
import { historyFloor, visibleTo } from '../../../packages/core/src/shared/search/visibleTo'
import parity from '../../../packages/core/src/shared/search/visibleTo.parity.json'
import { withContractDatabase } from './database'

describe('local search visibility against the migrated backend', () => {
  it.each(parity.cases)('$name', async (cell) => {
    await withContractDatabase(async (db) => {
      await db.query('BEGIN')
      const local = new DatabaseSync(':memory:')
      try {
        const people = new Map(['owner', 'peer', 'agent'].map((name) => [name, randomUUID()]))
        for (const name of ['owner', 'peer']) {
          await db.query("INSERT INTO identity.users(id,type,display_name) VALUES ($1,'human',$2)", [people.get(name), name])
        }
        const device = `search-parity-${randomUUID()}`
        await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)
          VALUES ($1,$2,'search parity','search parity','darwin')`, [device, people.get('owner')])
        await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id)
          VALUES ($1,'agent','search parity agent',$2,$3)`, [people.get('agent'), people.get('owner'), device])
        const chatNames = new Set([cell.document.chatId, ...cell.memberships.map((row) => row.chatId)])
        if (cell.sourceChatId) chatNames.add(cell.sourceChatId)
        const chats = new Map([...chatNames].map((name) => [name, randomUUID()]))
        // Seed the raw membership facts; all effects are rolled back, including deferred chat invariants.
        const ordered = [...chats].sort(([a], [b]) => Number(a === cell.document.chatId && !!cell.sourceChatId)
          - Number(b === cell.document.chatId && !!cell.sourceChatId))
        for (const [name, id] of ordered) {
          const source = name === cell.document.chatId ? cell.sourceChatId : null
          await db.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id,source_chat_id,source_message_id)
            VALUES ($1,$2,'search parity',$3,$4,$5)`,
          [id, source ? 'topic' : 'group', people.get('owner'), source ? chats.get(source) : null, source ? randomUUID() : null])
        }
        for (const member of cell.memberships) {
          await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'member')",
            [chats.get(member.chatId), people.get(member.actorId)])
          await db.query('UPDATE chat.chat_members SET hide_history_before=$3::timestamptz WHERE chat_id=$1 AND user_id=$2',
            [chats.get(member.chatId), people.get(member.actorId), member.floor.at])
        }
        const document = cell.document
        const backend = await db.query<{ visible: boolean }>(
          'SELECT chat.message_visible_to($1,$2::timestamptz,$3,$4,$5::text[],$6) AS visible',
          [chats.get(document.chatId), document.createdAt, document.isWhisper,
            document.senderId ? people.get(document.senderId) : null, document.toUserIds.map((id) => people.get(id)), people.get(cell.actorId)])
        expect(backend.rows[0]?.visible, 'backend floor and whisper predicate').toBe(cell.backendVisible)

        const memberships = cell.memberships.map((row) => ({ ...row, floor: { known: true as const, at: row.floor.at } }))
        const scope = historyFloor(document.chatId, cell.sourceChatId, cell.actorId, memberships)
        expect(visibleTo(document, cell.actorId, scope, cell.access), 'TypeScript with search-only deletion and hide restrictions')
          .toBe(cell.searchVisible)

        local.exec('PRAGMA foreign_keys=ON')
        local.exec(SEARCH_SCHEMA_SQL)
        for (const name of chats.keys()) {
          local.prepare('INSERT INTO chat VALUES (?,?,?,?)').run(name, name,
            name === document.chatId && cell.sourceChatId ? 'topic' : 'group', name === document.chatId ? cell.sourceChatId : null)
        }
        if (scope) {
          local.prepare('INSERT INTO actor_scope VALUES (?,?,?,?)').run(scope.actorId, scope.chatId,
            scope.floor.known ? 1 : 0, scope.floor.known && scope.floor.at ? searchTimestampMicros(scope.floor.at) : null)
        }
        local.prepare(`INSERT INTO msg(id,chat_id,thread_root_id,seq,sender_id,created_at,text,body,is_whisper,to_user_ids,deleted_at,has_file,has_image,has_link)
          VALUES (?,?,?,?,?,?,?,'',?,?,?,?,?,?)`).run(document.id, document.chatId, document.threadRootId,
          document.seq, document.senderId, searchTimestampMicros(document.createdAt), document.text,
          document.isWhisper ? 1 : 0, JSON.stringify(document.toUserIds), document.deletedAt ? searchTimestampMicros(document.deletedAt) : null,
          document.hasFile ? 1 : 0, document.hasImage ? 1 : 0, document.hasLink ? 1 : 0)
        if (cell.access) {
          local.prepare('INSERT INTO msg_actor VALUES (?,?,?,?)').run(cell.access.actorId, cell.access.messageId,
            cell.access.fromHistory ? 1 : 0, cell.access.hiddenForActor === null ? null : cell.access.hiddenForActor ? 1 : 0)
        }
        const query = buildSearchSql({ text: '', filters: {}, sort: 'recent' }, { accountId: 'account', actorId: cell.actorId })
        expect(local.prepare(query.sql).all(...query.params).map((row) => row.id), 'SQLite with the same actor and raw fixture')
          .toEqual(cell.searchVisible ? [document.id] : [])
      } finally {
        local.close()
        await db.query('ROLLBACK')
      }
    })
  })
})
