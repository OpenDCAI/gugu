import { getCurrentAuthUserId, identityDb } from './supabase'
import {
  readAgentCreateDefaults as readCoreAgentCreateDefaults,
  rememberAgentCreateDevice as rememberCoreAgentCreateDevice,
  rememberAgentCreateProject as rememberCoreAgentCreateProject,
} from '@gugu/core/cloud/agentCreateDefaults'
import type { SettingsTableClient } from '@gugu/core/cloud/userSettings'
import type { AgentCreateDefaults } from '@gugu/core/shared/ui/agentCreateDefaultsModels'

// @@@per-user-create-defaults (#2525) — renderer 侧只做「把 identity schema client 绑上去」，
// 规则全在 core（见 shared/ui/agentCreateDefaultsModels.ts）。
// ❌ 不经 lib/chat.ts：那是 chatService 的地盘，而这份偏好与聊天无关（且该文件被 #2510 占）。

const settingsClient = identityDb as unknown as SettingsTableClient

export async function readAgentCreateDefaults(): Promise<AgentCreateDefaults> {
  return readCoreAgentCreateDefaults(settingsClient, await getCurrentAuthUserId())
}

export async function rememberAgentCreateDevice(deviceId: string): Promise<AgentCreateDefaults> {
  return rememberCoreAgentCreateDevice(settingsClient, await getCurrentAuthUserId(), deviceId)
}

export async function rememberAgentCreateProject(
  deviceId: string,
  projectId: string | null,
): Promise<AgentCreateDefaults> {
  return rememberCoreAgentCreateProject(settingsClient, await getCurrentAuthUserId(), deviceId, projectId)
}
