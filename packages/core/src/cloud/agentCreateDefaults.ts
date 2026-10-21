import {
  mergeAgentCreateDeviceChoice,
  mergeAgentCreateProjectChoice,
  parseAgentCreateDefaults,
  type AgentCreateDefaults
} from '../shared/ui/agentCreateDefaultsModels'
import {
  readUserSettingsConfig,
  writeUserSettingsConfig,
  type SettingsTableClient
} from './userSettings'

// @@@per-user-create-defaults (#2525) — 共享 Session Composer 的设备/项目默认值，per-user 持久化。
// 载体是既有的 identity.user_settings（scope='user'，config.agent_create）：PK (user_id, scope)、
// RLS user_settings_own、GRANT ALL TO authenticated 都已就位 → 本功能**零迁移**。
// 读-改-写而不是服务端 patch 合并：'user' scope 下本功能是唯一的键，且「记住最近一次选择」本就
// 是 last-write-wins 语义，多客户端并发写不需要更强的保证。

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
  const config = await readUserSettingsConfig(client, userId, USER_SCOPE)
  const next = mergeAgentCreateDeviceChoice(config, deviceId)
  await writeUserSettingsConfig(client, userId, USER_SCOPE, next)
  return parseAgentCreateDefaults(next)
}

export async function rememberAgentCreateProject(
  client: SettingsTableClient,
  userId: string,
  deviceId: string,
  projectId: string | null
): Promise<AgentCreateDefaults> {
  const config = await readUserSettingsConfig(client, userId, USER_SCOPE)
  const next = mergeAgentCreateProjectChoice(config, deviceId, projectId)
  await writeUserSettingsConfig(client, userId, USER_SCOPE, next)
  return parseAgentCreateDefaults(next)
}
