import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_AGENT_TYPE,
  normalizeAgentType,
  VALID_AGENT_TYPES,
  type AgentType
} from '../../agentTypes'
import { atomicWriteText, ensureStateDirs, stateDir } from './paths'
import { acquireStateLock } from './fileLocks'
import { archiveAgentRecord } from './agentOwner'

export { DEFAULT_AGENT_TYPE, normalizeAgentType, VALID_AGENT_TYPES, type AgentType }

export interface LocalAgentRecord {
  name: string
  agent_type: AgentType
  path: string
  gugu_user_id: string
  prompt: string
  created_at: number
  cache?: Record<string, unknown> | null
  terminal_container?: string | null
  dm_chat_id?: string | null
  status?: string | null
}

export interface LocalAgentUpdate {
  name?: string | null
  agent_type?: string | null
  path?: string | null
  gugu_user_id?: string | null
  prompt?: string | null
  cache?: Record<string, unknown> | null
  terminal_container?: string | null
  dm_chat_id?: string | null
  status?: string | null
}

interface AgentsPayload {
  agents: LocalAgentRecord[]
}

export function agentsFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), 'agents.json')
}

// @@@resume-handle-unify - one canonical cache field for the provider's resumable session/thread:
function migrateAgentResumeHandle(agent: LocalAgentRecord): LocalAgentRecord {
  const cache = agent.cache
  if (!cache || typeof cache !== 'object') return agent
  if (!('session_id' in cache) && !('thread_id' in cache)) return agent
  const next: Record<string, unknown> = { ...cache }
  const handle =
    (typeof next.provider_session_id === 'string' && next.provider_session_id) ||
    (typeof next.session_id === 'string' && next.session_id) ||
    (typeof next.thread_id === 'string' && next.thread_id) ||
    ''
  delete next.session_id
  delete next.thread_id
  if (handle) next.provider_session_id = handle
  return { ...agent, cache: next }
}

async function loadAgentsPayload(env: NodeJS.ProcessEnv = process.env): Promise<AgentsPayload> {
  try {
    const payload = JSON.parse(await readFile(agentsFile(env), 'utf8')) as Partial<AgentsPayload>
    return Array.isArray(payload.agents)
      ? { agents: (payload.agents as LocalAgentRecord[]).map(migrateAgentResumeHandle) }
      : { agents: [] }
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return { agents: [] }
    throw err
  }
}

async function saveAgentsPayload(
  payload: AgentsPayload,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  await ensureStateDirs(env)
  await atomicWriteText(agentsFile(env), JSON.stringify(payload, null, 2))
}

async function acquireAgentsLock(env: NodeJS.ProcessEnv): Promise<() => Promise<void>> {
  // @@@agents-registry lock - agent create/update/remove is shared by terminal and runtime reconciliation.
  const lockDir = `${agentsFile(env)}.lock`
  await mkdir(stateDir(env), { recursive: true })
  return acquireStateLock(lockDir, 'agents')
}

export async function listAgents(
  env: NodeJS.ProcessEnv = process.env,
  options: { includeGuests?: boolean } = {}
): Promise<LocalAgentRecord[]> {
  const all = (await loadAgentsPayload(env)).agents
  // By default, exclude guest records (status='guest', no gugu_user_id) so callers that iterate
  // over real agents are never surprised by unactivated placeholders. Pass includeGuests:true
  // for paths that explicitly need to see or manage guest records.
  if (options.includeGuests) return [...all]
  return all.filter((a) => !isGuestAgentRecord(a))
}

/**
 * roster 里指向一条记录的方式。产品认一个 agent 只有两个**真身份**：云端 identity(`gugu_user_id`)，
 * 以及还没开户的 guest 靠以跑着的那条 provider 会话(`sessionId`)。
 *
 * ❌ 别再为「怎么指向这一行」另发一个本地 id。那种 id 不是身份，只是句柄，而句柄的唯一来源
 * 就是刚读出来的这条记录本身 —— 于是它既不能被别人拿来找人，也不落任何外键，只是让「同一个
 * agent 有几个 id」这个问题凭空多一个答案。
 */
export type AgentSelector = { guguUserId: string } | { providerSessionId: string }

export function agentMatchesSelector(agent: LocalAgentRecord, selector: AgentSelector): boolean {
  if ('guguUserId' in selector) {
    return Boolean(selector.guguUserId) && agent.gugu_user_id === selector.guguUserId
  }
  return Boolean(selector.providerSessionId) && cachedProviderSessionId(agent.cache) === selector.providerSessionId
}

function describeSelector(selector: AgentSelector): string {
  return 'guguUserId' in selector
    ? `gugu_user_id=${selector.guguUserId}`
    : `session_id=${selector.providerSessionId}`
}

export async function getAgent(
  selector: AgentSelector,
  env: NodeJS.ProcessEnv = process.env
): Promise<LocalAgentRecord | null> {
  // includeGuests:true so activation paths can load a still-unpromoted guest by its session id.
  const matches = (await listAgents(env, { includeGuests: true }))
    .filter((agent) => agentMatchesSelector(agent, selector))
  // ❌ 不静默取第一个：两条记录同时应答一个身份是数据坏了，掩盖它会让下游改错行。
  if (matches.length > 1) throw new Error(`agent selector is ambiguous: ${describeSelector(selector)}`)
  return matches[0] ?? null
}

export async function createAgent(
  input: {
    name: string
    agent_type: string
    path?: string | null
    gugu_user_id?: string | null
    prompt?: string | null
    terminal_container?: string | null
    dm_chat_id?: string | null
    status?: string | null
  },
  env: NodeJS.ProcessEnv = process.env
): Promise<LocalAgentRecord> {
  const name = input.name.trim()
  if (!name) throw new Error('agent name is required')
  const agent: LocalAgentRecord = {
    name,
    agent_type: normalizeAgentType(input.agent_type),
    path: input.path || '',
    gugu_user_id: input.gugu_user_id || '',
    prompt: input.prompt || '',
    created_at: Date.now() / 1000
  }
  if (input.terminal_container != null) agent.terminal_container = input.terminal_container
  if (input.dm_chat_id != null) agent.dm_chat_id = input.dm_chat_id
  if (input.status != null) agent.status = input.status
  const release = await acquireAgentsLock(env)
  try {
    const payload = await loadAgentsPayload(env)
    payload.agents.push(agent)
    await saveAgentsPayload(payload, env)
    return agent
  } finally {
    await release()
  }
}

export async function updateAgent(
  selector: AgentSelector,
  updates: LocalAgentUpdate,
  env: NodeJS.ProcessEnv = process.env
): Promise<LocalAgentRecord> {
  const release = await acquireAgentsLock(env)
  try {
    const payload = await loadAgentsPayload(env)
    const matches = payload.agents.filter((item) => agentMatchesSelector(item, selector))
    if (matches.length === 0) throw new Error(`Agent '${describeSelector(selector)}' does not exist`)
    if (matches.length > 1) throw new Error(`agent selector is ambiguous: ${describeSelector(selector)}`)
    const agent = matches[0]!
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) continue
      if (key === 'agent_type') {
        rejectNullRequiredAgentField(key, value)
        agent.agent_type = normalizeAgentType(String(value))
      } else if (key === 'name') {
        rejectNullRequiredAgentField(key, value)
        agent.name = String(value)
      } else if (key === 'path') {
        rejectNullRequiredAgentField(key, value)
        agent.path = String(value)
      } else if (key === 'gugu_user_id') {
        rejectNullRequiredAgentField(key, value)
        agent.gugu_user_id = String(value)
      } else if (key === 'prompt') {
        rejectNullRequiredAgentField(key, value)
        agent.prompt = String(value)
      } else if (key === 'cache') {
        agent.cache = value === null ? null : (value as Record<string, unknown>)
      } else if (key === 'terminal_container') {
        agent.terminal_container = value === null ? null : String(value)
      } else if (key === 'dm_chat_id') {
        agent.dm_chat_id = value === null ? null : String(value)
      } else if (key === 'status') {
        agent.status = value === null ? null : String(value)
      }
    }
    await saveAgentsPayload(payload, env)
    return agent
  } finally {
    await release()
  }
}

function rejectNullRequiredAgentField(field: string, value: unknown): void {
  if (value === null) throw new Error(`Agent field '${field}' cannot be null`)
}

/**
 * 按条件删除，返回被删掉的那些记录。
 *
 * 之所以是「按条件」而不是「按 id 一条条删」：真正的删除场景只有两个 —— 整表清空(设备解绑)和
 * 按规则清扫死 guest，两个都是集合操作。逐条删只是为了给每条记录一个句柄才存在的形状，而那个
 * 句柄正是被撤掉的本地 id。顺带解掉一件事：没有 session id 的死 guest 用任何身份都指不到，
 * 却仍然需要被清掉 —— 集合语义天然覆盖它。
 */
export async function removeAgents(
  match: (agent: LocalAgentRecord) => boolean,
  env: NodeJS.ProcessEnv = process.env
): Promise<LocalAgentRecord[]> {
  const release = await acquireAgentsLock(env)
  try {
    const payload = await loadAgentsPayload(env)
    const removed = payload.agents.filter((agent) => match(agent))
    if (removed.length === 0) return []
    payload.agents = payload.agents.filter((agent) => !match(agent))
    await saveAgentsPayload(payload, env)
    return removed
  } finally {
    await release()
  }
}

/** Archive matching roster rows under the existing roster lock, retaining their bindings. */
export async function archiveAgents(match: (agent: LocalAgentRecord) => boolean, env: NodeJS.ProcessEnv = process.env): Promise<LocalAgentRecord[]> {
  const release = await acquireAgentsLock(env)
  try {
    const payload = await loadAgentsPayload(env)
    const archived = payload.agents.filter((agent) => agent.status !== 'archived' && match(agent))
    for (const agent of archived) archiveAgentRecord(agent)
    if (archived.length) await saveAgentsPayload(payload, env)
    return archived
  } finally {
    await release()
  }
}

// @@@session-identity - the durable RUNTIME identity key: a captured agent stores the provider
export function cachedProviderSessionId(cache: Record<string, unknown> | null | undefined): string | null {
  const value = cache?.provider_session_id
  return typeof value === 'string' && value.trim() ? value : null
}

// @@@guest-invisible-ladder - guest records (status='guest', gugu_user_id='') are intentionally
export function isGuestAgentRecord(record: LocalAgentRecord): boolean {
  return record.status === 'guest' && !record.gugu_user_id
}

export async function matchAgentByProviderSessionId(
  providerSessionId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<LocalAgentRecord | null> {
  if (!providerSessionId) return null
  // Prefer a non-guest (registered) record over a guest placeholder for the same session id,
  // so a promoted/activated session takes precedence over any still-existing guest record even
  // before the guest record is cleaned up. (The old promotion entry `gugu agent register` died
  // with the CLI teardown #1021; the activation path is parked pending #1914's product decision.)
  let guestMatch: LocalAgentRecord | null = null
  for (const agent of await listAgents(env, { includeGuests: true })) {
    if (cachedProviderSessionId(agent.cache) !== providerSessionId) continue
    if (!isGuestAgentRecord(agent)) return agent
    if (!guestMatch) guestMatch = agent
  }
  return guestMatch
}

// @@@guest-toctou - creates a guest record and binds its session id in ONE lock acquisition so
// ⚠️ #1914 park:唯一非测试调用方是 guestRegistration.ts(写入侧随终端栈 teardown 断链,park 勿删)。
export async function createGuestAgentForProviderSession(
  input: {
    name: string
    agent_type: string
    path?: string | null
    providerSessionId: string
  },
  env: NodeJS.ProcessEnv = process.env
): Promise<{ created: boolean; record: LocalAgentRecord }> {
  const release = await acquireAgentsLock(env)
  try {
    const payload = await loadAgentsPayload(env)
    // Re-check inside the lock: any record (guest or not) already bound to this session id.
    const existing = payload.agents.find(
      (a) => cachedProviderSessionId(a.cache) === input.providerSessionId
    )
    if (existing) return { created: false, record: existing }

    const name = input.name.trim()
    if (!name) throw new Error('agent name is required')
    const agent: LocalAgentRecord = {
      name,
      agent_type: normalizeAgentType(input.agent_type),
      path: input.path || '',
      gugu_user_id: '',
      prompt: '',
      created_at: Date.now() / 1000,
      status: 'guest',
      // Bind the session id in the same write — no separate updateAgent call needed.
      cache: { provider_session_id: input.providerSessionId }
    }
    payload.agents.push(agent)
    await saveAgentsPayload(payload, env)
    return { created: true, record: agent }
  } finally {
    await release()
  }
}
