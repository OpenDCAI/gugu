import { archiveIdentity } from '@gugu/core/cloud/agentIdentityRemoval'
import { isPhoneDevice } from '@gugu/core/cloud/devices'
import type { Device } from '@gugu/core/shared/types/chat'
import type { ArchiveOutcome } from '@shared/core/sessions/sessions'
import { rpcOn } from '@renderer/lib/ipc'
import { showModal } from '@renderer/lib/modal/modal-provider'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { machineRpc } from '../mobile/agent-watch/sessionpage-rpc'
import { invokePhoneHost } from '../mobile/local-agent/phoneHostRpc'
import { platform } from '../platform'
import { chatService } from './chat'
import { getCurrentAuthUserId, identityDb } from './supabase'
import { i18n } from '../i18n'

type SessionTarget = { projectId: string; sessionId: string }
type ArchiveTarget = { device: Device; session: SessionTarget } | null
export type AgentArchiveOptions = { removeSocialIdentity?: boolean }

function host(device: Device) {
  return device.is_current_device ? rpcOn(null) : platform.kind === 'electron' ? rpcOn(device.device_id) : machineRpc(device.device_id)
}

/** Only an authoritative absent device/binding is "no task". Transport and directory failures propagate. */
export async function resolveAgentArchiveTarget(agentUserId: string): Promise<ArchiveTarget> {
  const owner = await getCurrentAuthUserId()
  const { data: agent, error } = await identityDb.from('users').select('id, device_id').eq('id', agentUserId).eq('owner_user_id', owner).eq('type', 'agent').single()
  if (error) throw error
  if (!agent.device_id) return null
  const { data: registered, error: deviceError } = await identityDb.from('gugu_devices').select('device_id').eq('user_id', owner).eq('device_id', agent.device_id).maybeSingle()
  if (deviceError) throw deviceError
  if (!registered) return null
  const device = (await chatService.listDevices({ includePhones: true, deviceIds: [agent.device_id] })).find((row) => row.device_id === agent.device_id)
  if (!device) throw new Error('The task host could not be resolved; reconnect and retry.')
  const session = isPhoneDevice(device)
    ? await invokePhoneHost<SessionTarget | null>(device.device_id, 'sessionTimeline.sessionOfAgent', [agentUserId])
    : await host(device).sessionTimeline.sessionOfAgent(agentUserId)
  return session ? { device, session } : null
}

export async function archiveOwnedAgent(agentUserId: string, options: AgentArchiveOptions = {}): Promise<void> {
  if (options.removeSocialIdentity !== undefined && typeof options.removeSocialIdentity !== 'boolean') throw new Error('removeSocialIdentity must be a boolean')
  const removeSocialIdentity = options.removeSocialIdentity ?? true
  const target = await resolveAgentArchiveTarget(agentUserId)
  if (!target) {
    if (!removeSocialIdentity) throw new Error(i18n.t('confirmations.archiveAgentNoTask', { ns: 'contacts' }))
    await archiveIdentity(identityDb, agentUserId)
    return
  }
  const { device, session } = target
  const args = [session.projectId, session.sessionId, { withChildren: false, removeSocialIdentity }] as const
  const outcome = isPhoneDevice(device)
    ? await invokePhoneHost<ArchiveOutcome>(device.device_id, 'sessions.archiveSession', [...args])
    : await host(device).sessions.archiveSession(...args)
  if (outcome.unreached.length) throw new Error('The task host could not be reached; reconnect and retry.')
}

/** Contacts and agent settings share the task archive choice; orphan identities explain their narrower effect. */
export async function confirmOwnedAgentArchive(agentUserId: string, name: string, archive: (id: string, options: AgentArchiveOptions) => Promise<void>): Promise<boolean> {
  const target = await resolveAgentArchiveTarget(agentUserId)
  const choice = await new Promise<boolean | null>((resolve) => showModal('confirmActionModal', {
    title: translateSessionMessage('task.archiveTaskTitle'),
    description: i18n.t(target ? 'confirmations.archiveAgent' : 'confirmations.archiveAgentNoTask', { ns: 'contacts', name }),
    confirmLabel: translateSessionMessage('task.archiveTaskConfirm'),
    variant: 'default',
    option: { label: translateSessionMessage('task.archiveRemoveSocialIdentity'), defaultChecked: true, disabled: !target },
    onSuccess: ({ optionChecked }) => resolve(optionChecked),
    onClose: () => resolve(null),
  }))
  if (choice === null) return false
  await archive(agentUserId, { removeSocialIdentity: choice })
  return true
}
