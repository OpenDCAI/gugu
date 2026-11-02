import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase'
import { userIdFromSupabaseAccessToken } from '@gugu/core/cloud/runtimeAuthProvider'
import { resolveGuguHome } from '@gugu/core/local/state/paths'
import { platformModelsEnabled } from '@gugu/core/cloud/optionalServices'
import { ASSISTANT_DEFAULT_MODEL } from '@gugu/core/shared/assistantPolicy'
import { ASSISTANT_PROVISION_SELECT, pickAssistant, provisionIdentityRemovedAt, type AssistantProvisionRow } from '@gugu/core/shared/assistantProvision'
import { createRPCController } from '@shared/lib/ipc/rpc'
import { currentAccountAccessToken } from '../extensions/account-token'
import { createLogger } from '../../../../lib/logger'
import { prepareLocalAssistantHome, wipeLocalAssistantHome } from '../../../../assistant-home-prepare'
import { createAssistantServerPreparation, type ServerPreparationRecord } from '../../../../assistant-server-preparation'
import {
  AssistantServerSetupError, assistantServerFailure,
  type AssistantServerBinding, type AssistantServerReply, type AssistantServerPreflight,
} from '../../../../../src/lib/assistantServerSetupTypes'

const log = createLogger('assistant-server-home')
const binding = z.object({ ownerUserId: z.uuid(), deviceId: z.uuid() }).strict()
const operation = binding.extend({ operationId: z.uuid() })
const cancellation = operation.extend({ state: z.object({ operationId: z.uuid(), phase: z.literal('cancelled'), installationStarted: z.boolean(), cancellable: z.literal(false) }) })
const start = operation.extend({ ownerProfile: z.string().max(8000) })
const wipe = binding.extend({ assistantId: z.uuid() })
let deviceId: (() => Promise<string | null>) | null = null
export function setAssistantHomeDeviceResolver(resolver: () => Promise<string | null>): void { deviceId = resolver }
const fail = (code: Parameters<typeof assistantServerFailure>[0]): never => { throw new AssistantServerSetupError(assistantServerFailure(code)) }
type CloseProvision = Pick<AssistantProvisionRow, 'agent_user_id' | 'agent' | 'phase'> & { provisioned_agent_user_id: string | null }
const retiredProvision = (row: CloseProvision) => !!row.provisioned_agent_user_id &&
  ((row.agent_user_id === null && row.phase === 'completed') || typeof provisionIdentityRemovedAt(row) === 'string')
const closeSelect = `${ASSISTANT_PROVISION_SELECT},provisioned_agent_user_id,operation_id`

async function account(input: AssistantServerBinding) {
  const token = await currentAccountAccessToken()
  const owner = token ? userIdFromSupabaseAccessToken(token) : null
  if (!owner || owner !== input.ownerUserId) return fail('account_changed')
  if (process.env.GUGU_SERVER_MODE !== '1' || process.env.GUGU_CLOUD_COMPUTER === '1' || process.platform !== 'linux') return fail('unsupported_platform')
  if (process.arch !== 'x64' && process.arch !== 'arm64') return fail('unsupported_arch')
  if (!deviceId || await deviceId() !== input.deviceId) return fail('target_not_owned')
  const client = createGuguSupabaseClient({ schema: 'identity', headers: { Authorization: `Bearer ${token}` } })
  return { client, owner }
}

async function validate(input: AssistantServerBinding, starting: boolean) {
  const { client } = await account(input)
  if (!starting) return
  const { data, error } = await client.from('agent_provisions').select(ASSISTANT_PROVISION_SELECT)
    .eq('owner_user_id', input.ownerUserId).eq('member_key', 'assistant')
  if (error) throw error
  if (pickAssistant((data ?? []) as AssistantProvisionRow[])) fail('assistant_exists')
  await account(input)
}

// Construct lazily: main.ts selects the account's GUGU_HOME after static imports.
let service: ReturnType<typeof createAssistantServerPreparation> | null = null
function preparation() {
  if (service) return service
  const directory = join(resolveGuguHome(), 'assistant-setup')
  const journal = join(directory, 'server-preparation.json')
  const cancelledDirectory = join(directory, 'cancelled')
  return service = createAssistantServerPreparation({
    read: async () => {
      try { return JSON.parse(await readFile(journal, 'utf8')) as ServerPreparationRecord }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    },
    write: async record => {
      await mkdir(directory, { recursive: true })
      const temporary = `${journal}.${process.pid}.tmp`
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600 })
      await rename(temporary, journal)
    },
    readCancellation: async input => {
      try {
        const record = cancellation.parse(JSON.parse(await readFile(join(cancelledDirectory, `${input.operationId}.json`), 'utf8')))
        if (record.ownerUserId !== input.ownerUserId || record.deviceId !== input.deviceId || record.operationId !== input.operationId || record.state.operationId !== input.operationId) fail('input_mismatch')
        return record.state
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    },
    writeCancellation: async (input, state) => {
      await mkdir(cancelledDirectory, { recursive: true })
      const file = join(cancelledDirectory, `${input.operationId}.json`)
      const temporary = `${file}.${process.pid}.tmp`
      await writeFile(temporary, JSON.stringify({ ownerUserId: input.ownerUserId, deviceId: input.deviceId, operationId: input.operationId, state }), { mode: 0o600 })
      await rename(temporary, file)
    },
    validate,
    retired: async input => {
      const { client } = await account(input)
      const { data, error } = await client.from('agent_provisions').select(closeSelect)
        .eq('owner_user_id', input.ownerUserId).eq('device_id', input.deviceId)
        .eq('operation_id', input.operationId).eq('member_key', 'assistant')
      if (error) throw error
      return !!data?.length && data.every(retiredProvision)
    },
    prepare: async (id, signal) => (await import('../../../../assistant-runtime-prepare')).prepareAssistantRuntime(id, signal),
    cleanup: async (id, keepRuntime) => (await import('../../../../assistant-runtime-prepare')).cleanupAssistantRuntimePreparation(id, keepRuntime),
    wipe: () => wipeLocalAssistantHome(),
    install: ownerProfile => prepareLocalAssistantHome({ ownerProfile }),
    log: (error, operationId) => log.error({ error, operationId }, 'assistant server preparation failed'),
  })
}

async function reply<T>(run: () => Promise<T>): Promise<AssistantServerReply<T>> {
  try { return { ok: true, value: await run() } }
  catch (error) {
    log.error({ error }, 'assistant server request failed')
    return { ok: false, error: error instanceof AssistantServerSetupError
      ? { code: error.code, retryable: error.retryable, next: error.next }
      : assistantServerFailure(error instanceof z.ZodError ? 'input_mismatch' : 'target_unreachable') }
  }
}

export const assistantHomeController = createRPCController({
  checkClose: (input: z.infer<typeof wipe>) => reply(async () => {
    const parsed = wipe.parse(input)
    const { client } = await account(parsed)
    const { data, error } = await client.from('agent_provisions').select(closeSelect)
      .eq('owner_user_id', parsed.ownerUserId).eq('device_id', parsed.deviceId).eq('member_key', 'assistant')
    if (error) throw error
    const matched = data?.find(row => row.provisioned_agent_user_id === parsed.assistantId)
    if (!matched) return fail('target_not_owned')
    if (data.some(row => row.agent_user_id && row.agent_user_id !== parsed.assistantId && !retiredProvision(row))) return fail('assistant_exists')
    await preparation().assertProvision(matched.operation_id)
    return { ready: true as const }
  }),
  preflight: (input: AssistantServerBinding) => reply(async (): Promise<AssistantServerPreflight> => {
    const parsed = binding.parse(input)
    await validate(parsed, true)
    return { version: 1, deviceId: parsed.deviceId, modelSource: platformModelsEnabled() ? 'platform' : 'target', defaultModel: platformModelsEnabled() ? ASSISTANT_DEFAULT_MODEL : null }
  }),
  start: (input: z.infer<typeof start>) => reply(() => preparation().start(start.parse(input))),
  status: (input: z.infer<typeof operation>) => reply(() => preparation().status(operation.parse(input))),
  cancel: (input: z.infer<typeof operation>) => reply(() => preparation().cancel(operation.parse(input))),
  wipe: (input: z.infer<typeof wipe>) => reply(async () => {
    const parsed = wipe.parse(input)
    const { client } = await account(parsed)
    // Governed archival retains the identity. Its removed_at receipt, or the
    // older hard-deleted identity, must be visible before wiping the home.
    const { data, error } = await client.from('agent_provisions').select(closeSelect)
      .eq('owner_user_id', parsed.ownerUserId).eq('device_id', parsed.deviceId)
      .eq('member_key', 'assistant')
    if (error) throw error
    const matched = data?.find(row => row.provisioned_agent_user_id === parsed.assistantId)
    if (!matched) return fail('target_not_owned')
    if (!retiredProvision(matched) || data.some(row => row.agent_user_id && !retiredProvision(row))) return fail('preparation_busy')
    await preparation().assertProvision(matched.operation_id)
    await account(parsed)
    return preparation().closeHome(matched.operation_id)
  }),
})
