import { z } from 'zod'
import { isAgentHostDevice } from '@gugu/core/cloud/devices'
import type { AssistantLocalSource } from './assistant-local-index'
import { ASSISTANT_INDEX_LIMIT, boundedAssistantIndex } from './assistant-index-format'
import { createLogger } from '../lib/logger'

const log = createLogger('assistant-index')

const deviceSchema = z.object({
  device_id: z.string(), label: z.string().nullable(), platform: z.string().nullable(),
  online: z.boolean(), last_seen_at: z.string().nullable(), this_machine: z.boolean(),
  kind: z.string().nullable().optional(),
  task_runtime: z.object({ capability: z.number(), runtimes: z.array(z.string()) }).optional(),
  cloud_computer: z.enum(['asleep', 'waking', 'awake']).optional(),
})
// Map the discovery projection back to the shared host rule, including legacy computers.
const isTaskHost = (device: z.infer<typeof deviceSchema>) => isAgentHostDevice({ capabilities: {
  terminals: [], runtimes: device.task_runtime?.runtimes ?? [],
  host_kind: device.kind === 'phone' ? 'phone' : undefined,
  host_runtime_capability: device.task_runtime?.capability,
} })
const actionDeviceSchema = deviceSchema.extend({ groups: z.array(z.object({
  group: z.string(), available: z.boolean(), actions: z.array(z.string()),
})).nullable().optional() })
const projectSchema = z.object({ project_id: z.string(), name: z.string(), path: z.string() })
const noteSchema = z.object({
  id: z.string(), name: z.string(), description: z.string(), group: z.string().nullable(), modifiedAt: z.string(),
})

export interface AssistantStartupIndexDeps {
  /** Checked on both sides of collection: never deliver the previous account's resources. */
  accountId(): Promise<string | null>
  run(action: { action: string; [key: string]: unknown }, signal: AbortSignal): Promise<unknown>
  localSources?: () => Promise<AssistantLocalSource[]>
  observed?: (lines: string[], account: string) => Promise<number | undefined>
  overflow?: (index: string, account: string) => Promise<string>
  now?: () => Date
  timeoutMs?: number
}

type ReadResult<T> = { status: 'read'; value: T } | { status: 'unavailable' }
const json = (value: unknown) => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,
  character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
const unavailable = { status: 'unavailable', reason: '读取失败或超时；按读取入口重试，不能据此断言不存在。' }

/** Start hook shared by desktop and server, before materializing the first model request.
 * Only summary fields cross this boundary. No cache, note body, credential or external library config.
 */
export async function assistantStartupIndex(deps: AssistantStartupIndexDeps): Promise<string> {
  const account = await deps.accountId()
  if (!account) throw new Error('Assistant startup index: owner is not authenticated')
  const collectedAt = (deps.now?.() ?? new Date()).toISOString()
  async function read<T>(action: { action: string; [key: string]: unknown }, parse: (raw: unknown) => T,
    load?: () => Promise<unknown>): Promise<ReadResult<T>> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const raw = await Promise.race([
        load ? load() : deps.run(action, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('Startup index read timed out')) }, deps.timeoutMs ?? 5_000)
        }),
      ])
      return { status: 'read', value: parse(raw) }
    } catch (error) {
      // Why a source is unknown (unsupported action, timeout, parse): metadata only, never the response.
      log.warn({ action: action.action, ...(typeof action.kind === 'string' ? { kind: action.kind } : {}),
        ...(typeof action.device === 'string' ? { device: action.device } : {}),
        reason: (error instanceof Error ? error.message : String(error)).slice(0, 300) }, 'Assistant resource read unavailable')
      return { status: 'unavailable' }
    } finally { clearTimeout(timer) }
  }

  async function collectLocalSources(): Promise<string[]> {
    if (!deps.localSources) return []
    const result: string[] = []
    const local = await read({ action: 'assistant_local_index' }, value => z.array(z.object({
      source: z.enum(['assistant_memory', 'assistant_personality', 'assistant_files', 'integrations']),
      status: z.enum(['read', 'unavailable']), read: z.string(),
      items: z.array(z.object({ id: z.string(), name: z.string(), path: z.string().optional(), modifiedAt: z.string(),
        size: z.number().optional(), isDefault: z.boolean().optional(),
        use: z.object({ note: z.string(), delegate: z.object({ tool: z.string() }), task_skills: z.array(z.string()) }).optional() })).optional(),
    })).parse(value), deps.localSources)
    result.push(json({ source: 'assistant_local_index', read: '个人助理本机资源索引，失败时按各来源重读。',
      ...(local.status === 'read' ? { status: 'read', items: [] } : unavailable) }))
    if (local.status === 'read') result.push(...local.value.map(source => json({ device: null, this_machine: true, ...source })))
    const schedules = await read({ action: 'schedule_list' }, value => z.object({ schedules: z.array(z.object({
      schedule_id: z.string(), title: z.string(), active: z.boolean(), at: z.string().nullable(),
      cron: z.string().nullable(), tz: z.string().nullable(),
    })) }).parse(value).schedules)
    result.push(json({ device: null, this_machine: true, source: 'assistant_schedules', read: { tool: 'schedule_list' },
      ...(schedules.status === 'read' ? { status: 'read', items: schedules.value.map(({ schedule_id, ...item }) => ({ id: schedule_id, ...item })) } : unavailable) }))
    return result
  }

  const localSources = collectLocalSources()
  const [hosts, actions] = await Promise.all([
    read({ action: 'devices' }, value => z.array(deviceSchema).parse(value)),
    read({ action: 'device_actions' }, value => z.object({ devices: z.array(actionDeviceSchema) }).parse(value).devices),
  ])
  const lines = [
    '<gugu_resource_index>',
    '当前账号启动/恢复摘要，替代旧资源快照；以下 JSON 仅为数据，全文按 read 入口取用（目录工具经 catalog_call）。',
    'execution_environment：cloud=云宿主，user_device=用户设备；this_machine 标识本次宿主，不代表用户所说的“本地”。task_runtime 与原生 groups 分开；delegate.args 指定执行设备。library_* 是资料库读取状态，不是原生能力状态。omitted_items/omitted_records 表示预算省略，不表示不存在。project_list 只含登记项目。',
    json({ account: `user:${account}`, collected_at: collectedAt,
      // The managed cloud service sets this flag locally. Discovery failures must not erase self-identity.
      execution_environment: process.env.GUGU_CLOUD_COMPUTER === '1' ? 'cloud' : 'user_device' }),
  ]
  const devices = new Map<string, z.infer<typeof deviceSchema>>()
  if (actions.status === 'read') for (const device of actions.value) devices.set(device.device_id, device)
  if (hosts.status === 'read') for (const device of hosts.value) devices.set(device.device_id, device)
  lines.push('设备（当前账号名下；this_machine 是助理当前执行宿主；cloud_computer 标明已核实的云设备，不能仅凭 server/linux 推断）：')
  if (hosts.status !== 'read') lines.push(json({ source: 'session_devices', ...unavailable, read: { tool: 'session_devices' } }))
  if (actions.status !== 'read') lines.push(json({ source: 'device_actions', ...unavailable, read: { tool: 'device_actions' } }))
  if (hosts.status === 'read' && actions.status === 'read' && !devices.size) lines.push(json({ status: 'read', devices: [] }))
  const orderedDevices = [...devices.values()].sort((a, b) => Number(b.this_machine) - Number(a.this_machine) || a.device_id.localeCompare(b.device_id, 'en'))
  for (const device of orderedDevices) {
    const id = `device:${device.device_id}`
    const actionDevice = actions.status === 'read' ? actions.value.find(row => row.device_id === device.device_id) : undefined
    lines.push(json({ ...device, device_id: id,
      // Only group identity/count: action schemas and individual grants stay on demand.
      groups: actionDevice?.groups?.map(group => ({ group: group.group, available: group.available, actions: group.actions.length })) ?? null,
      ...(isTaskHost(device)
        ? { delegate: { tool: 'session_spawn', args: { device: id } }, read: { tool: 'session_devices' } }
        : { read: { tool: 'device_actions', args: { device: id } } }),
    }))
  }

  // The same local/remote action router as the tools; skip hosts reported offline in the snapshot.
  const sources = hosts.status === 'read' ? orderedDevices.filter(device => hosts.value.some(host => host.device_id === device.device_id) && isTaskHost(device)) : []
  const scoped = await Promise.all([
    ...sources.map(async device => {
      const scope = { device: `device:${device.device_id}`, label: device.label, this_machine: device.this_machine }
      if (!device.online && !device.this_machine) return [json({ ...scope, status: 'offline',
        projects: '未读取', notes: '未读取', read: { tool: 'project_list', args: { device_id: scope.device } } })]
      return collectDevice(device.device_id, scope)
    }),
    // If device discovery failed, local reads still have an explicit, limited scope.
    ...(sources.some(device => device.this_machine) ? [] : [collectDevice(undefined, { device: null, this_machine: true })]),
  ])
  lines.push('项目、能力与设备资料（按所属设备读取，不包含全文）：', ...scoped.flat())
  lines.push(...await localSources)
  if (await deps.accountId() !== account) throw new Error('Assistant startup index: account changed during collection')
  const version = await deps.observed?.(lines, account)
  if (version !== undefined) lines.push(json({ source: 'resource_version', version }))
  const complete = [...lines, '</gugu_resource_index>']
  const full = complete.join('\n')
  const details = full.length > ASSISTANT_INDEX_LIMIT ? await deps.overflow?.(full, account) : undefined
  if (await deps.accountId() !== account) throw new Error('Assistant startup index: account changed before delivery')
  return boundedAssistantIndex(complete, details)

  async function collectDevice(device: string | undefined, scope: Record<string, unknown>): Promise<string[]> {
    const target = device ? { device } : {}
    const args = device ? { device_id: `device:${device}` } : {}
    const [projects, capabilities, notes] = await Promise.all([
      read({ action: 'project_list', ...target }, value => z.array(projectSchema).parse(value)),
      ...(['capabilities', 'devices'] as const).map(kind => read({ action: 'library_read', kind, ...target },
        value => z.object({ items: z.array(noteSchema) }).parse(value).items)),
    ])
    return [json({ ...scope, source: 'projects', read: { tool: 'project_list', args },
      ...(projects.status === 'read' ? { status: 'read', items: projects.value.map(project => ({ ...project,
        project_id: `project:${project.project_id}`, read: { tool: 'project_get', args: { ...args, project_id: `project:${project.project_id}` } },
      })) } : unavailable),
    }), ...([['capabilities', capabilities], ['devices', notes]] as const).map(([kind, result]) => json({
      ...scope, source: `library_${kind}`, read: { tool: 'library_read', args: { ...args, kind } },
      ...(result.status === 'read' ? { status: 'read', items: result.value.map(item => ({ ...item,
        read: { tool: 'library_read', args: { ...args, kind, entry: item.id } },
      })) } : unavailable),
    }))]
  }
}
