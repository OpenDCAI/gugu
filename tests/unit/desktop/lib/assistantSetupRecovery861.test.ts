// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentProvision, AgentProvisionOperation } from '@gugu/core/shared/types/agentProvision'

const db = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), owner: 'owner', readError: false }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: {} }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ identityDb: db, getCurrentAuthUserId: async () => db.owner }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: {
  waitForDeviceCommand: async () => { throw new Error('still pending') },
  getDeviceCommand: async () => ({ status: 'pending' }),
} }))
vi.mock('../../../../apps/desktop/src/lib/listDevicesOnceIdentified', () => ({ listDevicesOnceIdentified: async () => [{ device_id: 'device', is_online: true }] }))
vi.mock('../../../../apps/desktop/src/lib/cloudComputerStore', () => ({ provisionCloudComputer: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/contacts', () => ({ contactsService: { agentLookAvatarUrl: () => 'avatar' } }))
vi.mock('../../../../apps/desktop/src/platform/desktopIpc', () => ({ desktopIpc: () => ({ invoke: async () => ({ workdir: '/assistant' }) }) }))
vi.mock('../../../../apps/desktop/src/lib/assistantSetupPreparation', () => ({ prepareLocalAssistantSetup: async () => ({ workdir: '/assistant' }) }))

import { buildSingleBlueprint, type ProvisionResumeRecord } from '../../../../apps/desktop/src/lib/agentProvision'
import { assistantResumeStore, pendingLocalAssistant, resumeLocalAssistant, setUpAssistantOnThisComputer } from '../../../../apps/desktop/src/lib/assistantSetup'

const OLD_OP = '11111111-1111-4111-8111-111111111111'
const OLD_MEMBER = '22222222-2222-4222-8222-222222222222'
const input = { memberKey: 'assistant', displayName: 'Gugu', agentType: 'claude-code' as const, projectPath: '/assistant', inheritMemory: false, historyImportRequired: false }
let operations: Map<string, AgentProvisionOperation>
let members: Map<string, AgentProvision>
let record: ProvisionResumeRecord
let settle: 'cancelled' | 'cleaning_up' | 'error'

function operation(id: string): AgentProvisionOperation {
  return { id, owner_user_id: 'owner', device_id: 'device', kind: 'single', phase: 'provisioning_members', error: null } as AgentProvisionOperation
}
function member(id: string, operationId: string): AgentProvision {
  return { id, operation_id: operationId, owner_user_id: 'owner', device_id: 'device', member_key: 'assistant',
    display_name: 'Gugu', agent_type: 'claude-code', phase: 'awaiting_terminal', agent_user_id: null,
    provisioned_agent_user_id: 'removed-agent', create_command_id: 'old-command', error: null,
    history_import_required: false, history_thread_root_id: null } as AgentProvision
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('GUGU_PLATFORM_MODELS_ENABLED', 'false')
  localStorage.clear()
  db.owner = 'owner'; db.readError = false; settle = 'cancelled'
  operations = new Map([[OLD_OP, operation(OLD_OP)]])
  members = new Map([[OLD_MEMBER, member(OLD_MEMBER, OLD_OP)]])
  record = { version: 2, ownerUserId: 'owner', operationId: OLD_OP, deviceId: 'device',
    blueprint: buildSingleBlueprint({ ...input, provisionId: OLD_MEMBER }), members: [{ provisionId: OLD_MEMBER, memberKey: 'assistant' }] }
  assistantResumeStore.remember(record)
  db.from.mockImplementation((table: string) => {
    const filters: [string, unknown][] = []
    const rows = () => [...(table === 'agent_provisions' ? members.values() : operations.values())]
      .filter(row => filters.every(([key, value]) => (row as unknown as Record<string, unknown>)[key] === value))
    const answer = (single = false) => db.readError ? { data: null, error: { message: 'read refused' } }
      : { data: single ? rows()[0] ?? null : rows(), error: null }
    const query = { select: () => query, eq: (key: string, value: unknown) => { filters.push([key, value]); return query },
      order: () => query, maybeSingle: async () => answer(true), then: (resolve: (value: unknown) => unknown) => Promise.resolve(answer()).then(resolve) }
    return query
  })
  db.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    const id = String(args.p_operation_id)
    if (name === 'cancel_agent_provision_operation') {
      operations.get(id)!.phase = 'cleaning_up'
      return { data: null, error: null }
    }
    if (name === 'settle_provision_cancellation') {
      if (settle === 'error') return { data: null, error: { message: 'settlement refused' } }
      operations.get(id)!.phase = settle
      return { data: operations.get(id), error: null }
    }
    if (name === 'start_agent_provision_operation') {
      if (!operations.has(id)) {
        operations.set(id, operation(id))
        const blueprint = args.p_blueprint as { members: { provision_id: string }[] }
        const row = member(blueprint.members[0]!.provision_id, id)
        row.phase = 'queued'; row.agent_user_id = null; row.provisioned_agent_user_id = null
        members.set(row.id, row)
      }
      return { data: operations.get(id), error: null }
    }
    if (name === 'claim_provision_slots') {
      const rows = [...members.values()].filter(row => row.operation_id === id)
      rows.forEach(row => { row.phase = 'preparing' })
      return { data: rows, error: null }
    }
    if (name === 'prepare_agent_provision') {
      const row = members.get(String(args.p_provision_id))!
      row.phase = 'awaiting_terminal'; row.agent_user_id = 'new-agent'; row.provisioned_agent_user_id = 'new-agent'; row.create_command_id = 'new-command'
      return { data: row, error: null }
    }
    throw new Error(`unexpected RPC ${name}`)
  })
})

afterEach(() => vi.unstubAllEnvs())

describe('removed assistant setup recovery (#861)', () => {
  it.each(['error', 'cleaning_up'] as const)('keeps the exact pointer when cancellation is %s', async state => {
    settle = state
    await expect(resumeLocalAssistant(record)).rejects.toThrow(state === 'error' ? 'settlement refused' : /cleanup/i)
    expect(pendingLocalAssistant('owner')).toEqual(record)
    expect(db.rpc.mock.calls.map(call => call[0])).toEqual(['cancel_agent_provision_operation', 'settle_provision_cancellation'])
  })

  it('settles the removed operation, then only an explicit new setup allocates new IDs', async () => {
    await expect(resumeLocalAssistant(record)).rejects.toMatchObject({ kind: 'cancelled' })
    expect(operations.get(OLD_OP)?.phase).toBe('cancelled')
    expect(pendingLocalAssistant('owner')).toBeNull()
    expect(db.rpc.mock.calls.some(call => call[0] === 'start_agent_provision_operation')).toBe(false)
    await expect(setUpAssistantOnThisComputer({ name: 'Gugu', color: 0, rest: 'neutral', owner: { preferredName: 'Owner', about: '' } }, 'device'))
      .rejects.toMatchObject({ kind: 'still-starting' })
    const next = pendingLocalAssistant('owner')!
    expect(next.operationId).not.toBe(OLD_OP)
    expect(next.members[0]!.provisionId).not.toBe(OLD_MEMBER)
    expect(operations.get(OLD_OP)?.phase).toBe('cancelled')
  })

  it('resumes an interrupted live identity without cancellation or new operation IDs', async () => {
    members.get(OLD_MEMBER)!.agent_user_id = 'removed-agent'
    await expect(resumeLocalAssistant(record)).rejects.toMatchObject({ kind: 'still-starting' })
    expect(pendingLocalAssistant('owner')).toEqual(record)
    expect(db.rpc.mock.calls.map(call => call[0])).toEqual(['start_agent_provision_operation', 'prepare_agent_provision'])
  })

  it('does not cancel or forget another owner or an unreadable operation', async () => {
    db.owner = 'other'
    await expect(resumeLocalAssistant(record)).rejects.toThrow(/owner/)
    expect(db.from).not.toHaveBeenCalled()
    db.owner = 'owner'; db.readError = true
    await expect(resumeLocalAssistant(record)).rejects.toThrow('read refused')
    expect(db.rpc).not.toHaveBeenCalled()
    expect(pendingLocalAssistant('owner')).toEqual(record)
  })

  it('keeps the pointer when the cancellation intent itself fails', async () => {
    db.rpc.mockRejectedValueOnce(new Error('cancel refused'))
    await expect(resumeLocalAssistant(record)).rejects.toThrow('cancel refused')
    expect(db.rpc.mock.calls.map(call => call[0])).toEqual(['cancel_agent_provision_operation'])
    expect(pendingLocalAssistant('owner')).toEqual(record)
  })

  it('does not cancel a member belonging to a different operation', async () => {
    members.get(OLD_MEMBER)!.operation_id = 'other-operation'
    await expect(resumeLocalAssistant(record)).rejects.toThrow('does not belong')
    expect(db.rpc).not.toHaveBeenCalled()
    expect(pendingLocalAssistant('owner')).toEqual(record)
  })

  it('continues an authoritative cleaning_up operation instead of replaying create', async () => {
    operations.get(OLD_OP)!.phase = 'cleaning_up'
    await expect(resumeLocalAssistant(record)).rejects.toMatchObject({ kind: 'cancelled' })
    expect(pendingLocalAssistant('owner')).toBeNull()
    expect(db.rpc.mock.calls.map(call => call[0])).toEqual(['cancel_agent_provision_operation', 'settle_provision_cancellation'])
  })

  it.each(['cancelled', 'completed'] as const)('releases a removed member pointer only from the authoritative %s terminal', async phase => {
    operations.get(OLD_OP)!.phase = phase
    await expect(resumeLocalAssistant(record)).rejects.toMatchObject({ kind: 'cancelled' })
    expect(pendingLocalAssistant('owner')).toBeNull()
    expect(db.rpc).not.toHaveBeenCalled()
  })
})
