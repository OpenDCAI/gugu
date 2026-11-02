import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase'
import { userIdFromSupabaseAccessToken } from '@gugu/core'
import { resolveGuguHome } from '@gugu/core/local/state/paths'
import { platformModelsEnabled } from '@gugu/core/cloud/optionalServices'
import { ASSISTANT_DEFAULT_MODEL } from '@gugu/core/shared/assistantPolicy'
import { pickAssistant, type AssistantProvisionRow } from '@gugu/core/shared/assistantProvision'
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
const start = operation.extend({ ownerProfile: z.string().max(8000) })
const wipe = binding.extend({ assistantId: z.uuid() })
let deviceId: (() => Promise<string | null>) | null = null
export function setAssistantHomeDeviceResolver(resolver: () => Promise<string | null>): void { deviceId = resolver }
const fail = (code: Parameters<typeof assistantServerFailure>[0]): never => { throw new AssistantServerSetupError(assistantServerFailure(code)) }

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
  const { data, error } = await client.from('agent_provisions').select('agent_user_id,device_id,member_key,phase,created_at')
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
    validate,
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
    const { data, error } = await client.from('agent_provisions').select('agent_user_id,provisioned_agent_user_id,operation_id')
      .eq('owner_user_id', parsed.ownerUserId).eq('device_id', parsed.deviceId).eq('member_key', 'assistant')
    if (error) throw error
    const matched = data?.find(row => row.provisioned_agent_user_id === parsed.assistantId)
    if (!matched) return fail('target_not_owned')
    if (data.some(row => row.agent_user_id && row.agent_user_id !== parsed.assistantId)) return fail('assistant_exists')
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
    // Archival clears agent_user_id; the immutable provisioned identity remains
    // available for an interrupted close to finish home cleanup.
    const { data, error } = await client.from('agent_provisions').select('agent_user_id,provisioned_agent_user_id,operation_id')
      .eq('owner_user_id', parsed.ownerUserId).eq('device_id', parsed.deviceId)
      .eq('member_key', 'assistant')
    if (error) throw error
    const matched = data?.find(row => row.provisioned_agent_user_id === parsed.assistantId)
    if (!matched) return fail('target_not_owned')
    if (data.some(row => row.agent_user_id)) return fail('preparation_busy')
    await preparation().assertProvision(matched.operation_id)
    await account(parsed)
    const result = await wipeLocalAssistantHome()
    await preparation().closed()
    return result
  }),
})
