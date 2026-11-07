import type { MessageItem } from '@gugu/core/shared/types/chat'

export interface MessageSqlDatabase {
  prepare(sql: string): {
    run(...values: unknown[]): unknown
    get(...values: unknown[]): unknown
    all(...values: unknown[]): unknown[]
  }
  transaction<Args extends unknown[], Result>(body: (...args: Args) => Result): (...args: Args) => Result
}
type Statement = ReturnType<MessageSqlDatabase['prepare']>

/** Each SQL text compiles once per connection; every later prepare of the same text returns that statement. */
export function reusingStatements(connection: MessageSqlDatabase): MessageSqlDatabase {
  const statements = new Map<string, Statement>()
  return {
    prepare(sql) {
      let statement = statements.get(sql)
      if (!statement) statements.set(sql, statement = connection.prepare(sql))
      return statement
    },
    transaction: body => connection.transaction(body),
  }
}
export type StoredMessage = { rowid: number; id: string; chat_id: string; thread_root_id: string | null;
  seq: number; sender_user_id: string | null; created_at: string; content_type: MessageItem['content_type'];
  content: string | null; is_whisper: number; to_user_ids: string; file_item_id: string | null; rest: string }
const columns = ['id', 'chat_id', 'thread_root_id', 'seq', 'sender_user_id', 'created_at',
  'content_type', 'content', 'is_whisper', 'to_user_ids', 'file_item_id'] as const
export const decimal = /^(0|[1-9]\d*)$/

export function requireId(id: string): void {
  if (typeof id !== 'string' || !id.trim()) throw new Error('Persistent messages require a scoped identity')
}

export function requireLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid persistent message page limit')
}

/** Everything that is not a query column, minus renderer-only fields; absent columns stay absent on restore. */
export function encodeRest(message: MessageItem): string {
  const rest = { ...message } as Record<string, unknown>
  const absent = columns.filter(key => !(key in message))
  for (const key of [...columns, 'account_id', 'image_dimensions']) delete rest[key]
  for (const key of Object.keys(rest)) if (key.startsWith('local_send_')) delete rest[key]
  if (absent.length) rest._absent = absent
  return JSON.stringify(rest)
}

export function restore(row: StoredMessage): MessageItem {
  const { _absent = [], ...rest } = JSON.parse(row.rest)
  const value: Record<string, unknown> = { ...rest }
  for (const key of columns) value[key] = row[key]
  value.is_whisper = row.is_whisper === 1
  value.to_user_ids = JSON.parse(row.to_user_ids)
  for (const key of _absent) delete value[key]
  return value as unknown as MessageItem
}

/** Rows and their search index entries leave together. */
export function dropMessages(connection: MessageSqlDatabase, where: string, ...args: unknown[]): void {
  connection.prepare(`DELETE FROM im_messages_text WHERE rowid IN (SELECT rowid FROM im_messages WHERE ${where})`).run(...args)
  connection.prepare(`DELETE FROM im_messages WHERE ${where}`).run(...args)
}

export function dropRanges(connection: MessageSqlDatabase, accountId: string, chatId: string): void {
  connection.prepare('DELETE FROM im_message_ranges WHERE account_id=? AND chat_id=?').run(accountId, chatId)
}
