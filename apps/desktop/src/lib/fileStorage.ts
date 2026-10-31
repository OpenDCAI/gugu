import { readUserSettingsConfig, writeUserSettingsConfig, type SettingsTableClient } from '@gugu/core/cloud/userSettings'
import { parseFileStorage, type FileStorage } from '@gugu/core/shared/fileStorage'
import { chatDb, identityDb } from './supabase'

// 「文件存储与读取」的读写(规则在 @gugu/core/shared/fileStorage)。宿主不缓存这一格:后端每次用到时现读,改完下一次就生效。

const settingsClient = identityDb as unknown as SettingsTableClient
const USER_SCOPE = 'user'

export async function readFileStorage(userId: string): Promise<FileStorage> {
  return parseFileStorage(await readUserSettingsConfig(settingsClient, userId, USER_SCOPE))
}

/** 读-改-写同一行:配置里别的键原样留着,file_storage 里这一版不认识的键(更新的客户端写的)也原样留着。 */
export async function writeFileStorage(userId: string, change: Partial<FileStorage>): Promise<FileStorage> {
  const config = await readUserSettingsConfig(settingsClient, userId, USER_SCOPE)
  const next = { ...parseFileStorage(config), ...change }
  await writeUserSettingsConfig(settingsClient, userId, USER_SCOPE, { ...config, file_storage: { ...(config.file_storage as Record<string, unknown> | undefined), ...next } })
  return next
}

/** What the 「文件存储与读取」 dashboard shows: the caller's own cloud copies (chat.file_storage_overview_as). */
export type FileStorageClass = 'image' | 'temporary' | 'kept'
export type FileStorageOverview = {
  total_bytes: number
  count: number
  expiring_7d_bytes: number
  classes: Record<FileStorageClass, { bytes: number; count: number }>
  groups: { chat_id: string; name: string | null; project: boolean; bytes: number; count: number }[]
  expiring: { chat_id: string; expires_at: string; bytes: number; class: FileStorageClass; item_id: string | null; file_name: string | null }[]
  machines: { device_id: string; label: string; files: number; bytes: number; temporary_copy_bytes: number }[]
}

export async function readFileStorageOverview(): Promise<FileStorageOverview> {
  const { data, error } = await chatDb.rpc('file_storage_overview_as')
  if (error) throw new Error(error.message)
  return data as FileStorageOverview
}

/** One of the caller's copies by its message or folder file, or every one of a class (in a chat, or all). */
export type FileStorageRef = { message_id: string } | { item_id: string } | { class: FileStorageClass; chat_id?: string }

/** The uploader marks copies temporary, kept (permanent) or clears them now (release); the server refuses anyone else's. */
export async function markFileStorage(refs: FileStorageRef[], action: 'temporary' | 'permanent' | 'release'): Promise<number> {
  const { data, error } = await chatDb.rpc('file_storage_mark_as', { p_refs: refs, p_action: action })
  if (error) throw new Error(error.message)
  return data as number
}
