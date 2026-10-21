import type { GuguSettingsRow, GuguSettingsScope } from '../shared/types/chat'
import { dbPayload } from './supabase'

// @@@one-settings-io-path — identity.user_settings 的读写只有这一条路。此前它内联在
// deviceSshConfig.ts 里（ssh_target 是当时唯一的消费者）；#2525 的 per-user 创建默认值是第二个
// 消费者，与 ssh 无关，所以把 client 契约 + 行归一化抬到这里，两边共用一份。

type SettingsQueryResult = {
  data: unknown
  error: { message: string } | null
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
