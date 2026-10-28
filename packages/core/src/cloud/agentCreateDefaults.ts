import {
  mergeAgentCreateDeviceChoice,
  mergeAgentCreateProjectChoice,
  parseAgentCreateDefaults,
  type AgentCreateDefaults
} from '../shared/ui/agentCreateDefaultsModels'
import {
  readUserSettingsConfig,
  mutateUserSettingsConfig,
  type SettingsTableClient
} from './userSettings'

// @@@per-user-create-defaults (#2525) — 共享 Session Composer 的设备/项目默认值，per-user 持久化。
// 载体是既有的 identity.user_settings（scope='user'，config.agent_create）：PK (user_id, scope)、
// RLS user_settings_own、GRANT ALL TO authenticated 都已就位 → 本功能**零迁移**。
// 同一行还放账号 App、导览等设置：条件写只修改当前键，冲突后在新行上重新合并。

const USER_SCOPE = 'user' as const

export async function readAgentCreateDefaults(
  client: SettingsTableClient,
  userId: string
): Promise<AgentCreateDefaults> {
  return parseAgentCreateDefaults(await readUserSettingsConfig(client, userId, USER_SCOPE))
}

export async function rememberAgentCreateDevice(
  client: SettingsTableClient,
  userId: string,
  deviceId: string
): Promise<AgentCreateDefaults> {
  const next = await mutateUserSettingsConfig(client, userId, USER_SCOPE,
    (config) => mergeAgentCreateDeviceChoice(config, deviceId))
  return parseAgentCreateDefaults(next)
}

export async function rememberAgentCreateProject(
  client: SettingsTableClient,
  userId: string,
  deviceId: string,
  projectId: string | null,
  chatId?: string | null
): Promise<AgentCreateDefaults> {
  const next = await mutateUserSettingsConfig(client, userId, USER_SCOPE,
    (config) => mergeAgentCreateProjectChoice(config, deviceId, projectId, chatId))
  return parseAgentCreateDefaults(next)
}
