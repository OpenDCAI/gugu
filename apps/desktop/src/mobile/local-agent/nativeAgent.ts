import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import type { DeviceActionOutcome } from '@gugu/core/cloud/deviceActionHost'
import type { PhoneDeviceInfo } from '../phone-device/nativePhoneActions'
import type { PhoneGroupGrants } from '../phone-device/phoneActionCatalog'
import type { phoneDeviceRow } from '../phone-device/phoneDeviceRow'

export const phoneAgentAvailable = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('GuguAgent')

export interface PhoneAgentState {
  ownerId?: string
  sessionId?: string
  status: 'idle' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'
  text?: string
  events: Array<{ type: string; name?: string; message?: string; text?: string; node?: string; arch?: string; platform?: string; result?: { details?: { ok?: boolean; code?: string } } }>
}

export interface PhoneAgentHostState {
  taskTimeline?: boolean
  project?: { id: string; name: string; path: string }
  ownerId?: string
  deviceId?: string
  status: 'starting' | 'ready' | 'failed' | 'stopped' | 'interrupted'
  ready: boolean
  lastHeartbeatAt?: number
  error?: string
  message?: string
  sessions: PhoneAgentSession[]
}

export interface PhoneAgentSession {
  agentUserId: string
  sessionId: string
  displayName: string
  status: string
  chatId: string
  modelId: string
  lastError?: string | null
  lastJobStatus?: string | null
  lastActiveAt?: string | null
}

export interface PhoneAgentConversation { agentUserId: string; chatId: string }
export interface PhoneAgentHostCall {
  ownerId: string
  id: string
  channel: string
  args: unknown[]
}
export interface PhoneAgentHostReply { result?: unknown; error?: { code: string; message: string } }

export interface PhoneAgentHostConfig {
  ownerId: string
  deviceId: string
  installId: string
  deviceInfo: PhoneDeviceInfo
  supabaseUrl: string
  supabaseAnonKey: string
  accessToken: string
  refreshToken: string
  expiresAt?: number
  grants: PhoneGroupGrants
  deviceRow: ReturnType<typeof phoneDeviceRow>
}

export interface PhoneAgentWebAction {
  id: string
  ownerId: string
  sessionId: string
  action: string
  args: Record<string, unknown>
}

export const nativeAgent = registerPlugin<{
  configure(input: PhoneAgentHostConfig): Promise<PhoneAgentHostState>
  hostState(input: { ownerId: string }): Promise<PhoneAgentHostState>
  hostCall(input: PhoneAgentHostCall): Promise<PhoneAgentHostReply>
  stopHost(input: { ownerId: string; clearCredentials?: boolean }): Promise<void>
  addListener(event: 'webAction', listener: (request: PhoneAgentWebAction) => void): Promise<PluginListenerHandle>
  webActionResult(input: { ownerId: string; id: string; result: DeviceActionOutcome }): Promise<void>
  cancelSession(input: { ownerId: string; sessionId: string }): Promise<void>
  run(input: { ownerId: string; sessionId: string; prompt: string; baseUrl: string; apiKey: string; model: string }): Promise<{ accepted: boolean }>
  state(input: { ownerId: string }): Promise<PhoneAgentState>
  grants(input: { ownerId: string; calendar: boolean; groups?: PhoneGroupGrants }): Promise<void>
  cancel(input: { ownerId: string }): Promise<void>
  clear(input: { ownerId: string }): Promise<void>
}>('GuguAgent')
