import type { GuguSettingsRow, GuguSettingsScope } from '../shared/types/chat'
import { dbPayload } from './supabase'

// @@@one-settings-io-path — identity.user_settings 的读写只有这一条路。此前它内联在
// deviceSshConfig.ts 里（ssh_target 是当时唯一的消费者）；#2525 的 per-user 创建默认值是第二个
// 消费者，与 ssh 无关，所以把 client 契约 + 行归一化抬到这里，两边共用一份。

type SettingsQueryResult = {
  data: unknown
  error: { message: string; code?: string } | null
}

type SettingsWriteSelection = {
  select(columns: string): { maybeSingle(): PromiseLike<SettingsQueryResult> }
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
    /** Optional on read-only adapters. Mutations require both operations; no blind-write fallback. */
    update?(values: Record<string, unknown>): {
      eq(column: 'user_id', value: string): {
        eq(column: 'scope', value: string): {
          eq(column: 'updated_at', value: string): SettingsWriteSelection
        }
      }
    }
    insert?(values: Record<string, unknown>): SettingsWriteSelection
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
  const { data, error } = await client
    .from('user_settings')
    .select(SETTINGS_COLUMNS)
    .eq('user_id', userId)
    .eq('scope', scope)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return normalizeSettingsRow(data)?.config ?? {}
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

/**
 * Change one account setting without dropping another device's concurrent change.
 * The mutator is pure: on a revision conflict it is applied again to the newest row.
 * Existing rows use updated_at as their compare-and-swap token; a missing row is
 * inserted, never upserted over a row another writer may have just created.
 */
export async function mutateUserSettingsConfig(
  client: SettingsTableClient,
  userId: string,
  scope: GuguSettingsScope,
  change: (config: Record<string, unknown>) => Record<string, unknown>
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const read = await client.from('user_settings').select(SETTINGS_COLUMNS)
      .eq('user_id', userId).eq('scope', scope).maybeSingle()
    if (read.error) throw new Error(read.error.message)
    const previous = normalizeSettingsRow(read.data)
    const config = previous?.config ?? {}
    const next = change(config)
    if (next === config) return config
    const table = client.from('user_settings')
    if (!table.update || !table.insert) throw new Error('The settings client cannot perform conditional writes')
    // A frozen clock or two writes within one millisecond must still change the revision.
    const before = previous ? Date.parse(previous.updated_at) : 0
    const updatedAt = new Date(Math.max(Date.now(), Number.isFinite(before) ? before + 1 : 0)).toISOString()
    const values = dbPayload({ user_id: userId, scope, config: next, updated_at: updatedAt })
    const written = previous
      ? await table.update(values).eq('user_id', userId).eq('scope', scope)
        .eq('updated_at', previous.updated_at).select(SETTINGS_COLUMNS).maybeSingle()
      : await table.insert(values).select(SETTINGS_COLUMNS).maybeSingle()
    if (written.error) {
      if (!previous && written.error.code === '23505') continue
      throw new Error(written.error.message)
    }
    const row = normalizeSettingsRow(written.data)
    if (row) return row.config
    // No updated row: another writer changed the revision. Re-read, then reapply only our change.
  }
  throw new Error('Account settings changed repeatedly; try saving again')
}
