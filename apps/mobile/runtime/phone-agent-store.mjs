import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export function uuid(value, label = 'id') {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${label} must be a UUID`)
  return value
}

export function stableId(...parts) {
  const hex = createHash('sha256').update(JSON.stringify(parts)).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** One owner-scoped journal. Admission is durable before the cloud read receipt advances. */
export async function openPhoneAgentStore(root, ownerId) {
  uuid(ownerId, 'ownerId')
  if (!root) throw new Error('GUGU_AGENT_HOME is not configured')
  const directory = join(root, 'hosts', ownerId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, 'host.json')
  let state
  try { state = JSON.parse(await readFile(path, 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    state = { version: 1, ownerId, agents: {}, jobs: {}, outbox: {}, requests: {}, leases: {} }
  }
  if (state.version !== 1 || state.ownerId !== ownerId) throw new Error('phone host journal owner or version mismatch')
  state.artifacts ??= {}
  state.fileOutbox ??= {}
  let writing = Promise.resolve()
  const save = () => {
    const serialized = JSON.stringify(state)
    writing = writing.catch(() => undefined).then(async () => {
      const temporary = `${path}.${randomUUID()}.tmp`
      await writeFile(temporary, serialized, { mode: 0o600 })
      await rename(temporary, path)
    })
    return writing
  }
  // A process that died during a tool call cannot know whether that call took effect.
  // Retain that interrupted turn and never automatically replay its side effects.
  for (const job of Object.values(state.jobs)) {
    if (job.status === 'running') {
      job.status = 'interrupted'
      job.finishedAt = new Date().toISOString()
      job.error = '手机运行进程中断，这轮执行结果尚未确认；请检查结果后重新发起任务。'
      const agent = state.agents[job.agentUserId]
      if (agent) { agent.status = 'error'; agent.lastError = job.error }
    }
  }
  for (const job of Object.values(state.jobs)) if (job.status === 'interrupted' && !job.finishedAt) job.finishedAt = new Date().toISOString()
  await save()
  return { directory, state, save, flush: () => writing }
}

export async function admitPhoneJob(store, input) {
  uuid(input.id, 'job id')
  uuid(input.agentUserId, 'agentUserId')
  const job = store.state.jobs[input.id] ?? { ...input, status: 'queued', createdAt: new Date().toISOString() }
  store.state.jobs[input.id] = job
  // A prior save may have failed after admission entered memory. A duplicate is acknowledged
  // only after this save succeeds, without replacing or requeueing the original job.
  await store.save()
  return job
}
