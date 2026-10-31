import type { GuguSettingsRow, GuguSettingsScope } from '../shared/types/chat'
import { dbPayload } from './supabase'

// @@@one-settings-io-path — identity.user_settings 的读写只有这一条路。此前它内联在
// deviceSshConfig.ts 里（ssh_target 是当时唯一的消费者）；#2525 的 per-user 创建默认值是第二个
// 消费者，与 ssh 无关，所以把 client 契约 + 行归一化抬到这里，两边共用一份。

type SettingsQueryResult = {
  data: unknown
  error: { message: string; code?: string } | null
}

type SettingsConditionalUpdate = {
  eq(column: 'user_id' | 'scope' | 'updated_at', value: string): SettingsConditionalUpdate
  select(columns: string): { maybeSingle(): PromiseLike<SettingsQueryResult> }
}

export interface VersionedSettingsTableClient extends SettingsTableClient {
  from(table: 'user_settings'): ReturnType<SettingsTableClient['from']> & {
    update(values: Record<string, unknown>): SettingsConditionalUpdate
    insert(values: Record<string, unknown>): {
      select(columns: string): { maybeSingle(): PromiseLike<SettingsQueryResult> }
    }
  }
}

export interface SettingsTableClient {
  from(table: 'user_settings'): {
    select(columns: string): {
      eq(
        column: 'user_id',
        value: string
      ): {
        eq(column: 'scope', value: string): {
          maybeSingle(): PromiseLike<SettingsQueryResult>
        }
      }
    }
    upsert(
      values: Record<string, unknown>,
      options: { onConflict: string }
    ): {
      select(columns: string): {
        single(): PromiseLike<SettingsQueryResult>
      }
    }
  }
}

const SETTINGS_COLUMNS = 'scope, config, updated_at'

export function normalizeSettingsRow(value: unknown): GuguSettingsRow | null {
  if (!value || typeof value !== 'object') return null
  const row = value as { scope?: unknown; config?: unknown; updated_at?: unknown }
  if (typeof row.scope !== 'string' || typeof row.updated_at !== 'string') {
    throw new Error('user_settings row is malformed')
  }
  const config = row.config && typeof row.config === 'object' && !Array.isArray(row.config)
    ? (row.config as Record<string, unknown>)
    : {}
  return { scope: row.scope as GuguSettingsRow['scope'], config, updated_at: row.updated_at }
}

/** 缺行 = 空配置（用户还没设过任何东西），不是错误。查询本身失败仍然 throw。 */
export async function readUserSettingsConfig(
  client: SettingsTableClient,
  userId: string,
  scope: GuguSettingsScope
): Promise<Record<string, unknown>> {
  return (await readUserSettingsRow(client, userId, scope))?.config ?? {}
}

async function readUserSettingsRow(client: SettingsTableClient, userId: string, scope: GuguSettingsScope): Promise<GuguSettingsRow | null> {
  const { data, error } = await client
    .from('user_settings')
    .select(SETTINGS_COLUMNS)
    .eq('user_id', userId)
    .eq('scope', scope)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return normalizeSettingsRow(data)
}

/** Reapply one preference edit to the latest row; a stale version must never overwrite another device. */
export async function updateUserSettingsConfig(
  client: VersionedSettingsTableClient,
  userId: string,
  scope: GuguSettingsScope,
  edit: (config: Record<string, unknown>) => Record<string, unknown>
): Promise<GuguSettingsRow> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const before = await readUserSettingsRow(client, userId, scope)
    const version = before ? Date.parse(before.updated_at) : 0
    if (!Number.isFinite(version)) throw new Error('Invalid user_settings version')
    const values = dbPayload({ user_id: userId, scope, config: edit(before?.config ?? {}),
      updated_at: new Date(Math.max(Date.now(), version + 1)).toISOString() })
    const table = client.from('user_settings')
    const { data, error } = before
      ? await table.update(values).eq('user_id', userId).eq('scope', scope).eq('updated_at', before.updated_at).select(SETTINGS_COLUMNS).maybeSingle()
      : await table.insert(values).select(SETTINGS_COLUMNS).maybeSingle()
    if (error) {
      if (!before && error.code === '23505') continue
      throw new Error(error.message)
    }
    const saved = normalizeSettingsRow(data)
    if (saved) return saved
  }
  throw new Error('Settings changed on another device; try again')
}

export async function writeUserSettingsConfig(
  client: SettingsTableClient,
  userId: string,
  scope: GuguSettingsScope,
  config: Record<string, unknown>
): Promise<GuguSettingsRow> {
  const { data, error } = await client
    .from('user_settings')
    .upsert(
      dbPayload({
        user_id: userId,
        scope,
        config,
        updated_at: new Date().toISOString()
      }),
      { onConflict: 'user_id,scope' }
    )
    .select(SETTINGS_COLUMNS)
    .single()
  if (error) throw new Error(error.message)
  const row = normalizeSettingsRow(data)
  if (!row) throw new Error('user_settings upsert returned no row')
  return row
}
