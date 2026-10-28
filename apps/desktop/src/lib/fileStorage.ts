import { readUserSettingsConfig, writeUserSettingsConfig, type SettingsTableClient } from '@gugu/core/cloud/userSettings'
import { parseFileStorage, type FileStorage } from '@gugu/core/shared/fileStorage'
import { identityDb } from './supabase'

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
