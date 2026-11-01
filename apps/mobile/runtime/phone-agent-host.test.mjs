import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, mkdir, writeFile, appendFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { buildSessionDirectEnvelope } from '../../../packages/core/src/local/agent/deliveryEnvelope.ts'
import { startPhoneAgentHost } from './phone-agent-host.mjs'
import { openPhoneAgentStore } from './phone-agent-store.mjs'
import { createPhoneTimelineRuntime } from './phone-agent-timeline.mjs'
import { bindAgentEntry, createAgentEntry } from './agent-entry.mjs'
import { createPhoneProvisioner } from './phone-agent-provision.mjs'
import { createPhoneActionRuntime } from './phone-actions.mjs'

const ownerId = '68a158dd-1832-4671-ac02-ebde330d3d7a'
const installId = '22a953e8-e021-4789-9fc9-e41ecb37295b'
const deviceId = `phone-${installId}-${ownerId}`
const agentId = '558fcc98-9d61-4054-8a18-900d969b1849'
const chatId = 'a540c592-971b-4bcf-89c3-944484a14640'
const groupId = '0c44ad9d-8fed-4285-ab8c-469c91101cf6'

function fakeCloud() {
  const commands = []
  const calls = []
  const messages = []
  const notices = []
  const inboxRows = []
  const devices = []
  const users = [{ id: agentId, type: 'agent', owner_user_id: ownerId, device_id: deviceId, display_name: '手机 Agent', desired_status: 'online' }, { id: ownerId, type: 'human', display_name: '主人' }]
  let provision
  const identity = {
    rpc: async (name, args) => {
      calls.push([name, args])
      if (name === 'fetch_fair_pending_device_commands') return { data: commands.filter((command) => command.status === 'pending'), error: null }
      if (name === 'recheck_device_command_execution') return { data: true, error: null }
      if (name === 'recover_orphaned_device_commands') return { data: 0, error: null }
      return { data: {}, error: null }
    },
    from: (table) => {
      let filters = []
      let patch
      const result = () => {
        if (table === 'active_users') return { data: users.filter((entry) => filters.every(([key, value]) => Array.isArray(value) ? value.includes(entry[key]) : entry[key] === value)), error: null }
        if (table === 'gugu_devices') {
          const matching = devices.filter((device) => filters.every(([key, value]) => device[key] === value))
          if (patch) { calls.push(['update_device', { patch, filters }]); for (const device of matching) Object.assign(device, patch) }
          return { data: matching, error: null }
        }
        if (table === 'chats') return { data: [{ id: groupId, kind: 'group', status: 'active' }], error: null }
        if (table === 'active_members') return { data: [], error: null }
        if (table === 'agent_provisions') return { data: provision, error: null }
        if (table === 'gugu_device_commands') {
          const matching = commands.filter((command) => filters.every(([key, value]) => command[key] === value))
          if (patch) for (const command of matching) Object.assign(command, patch)
          return { data: matching, error: null }
        }
        throw new Error(`unexpected table ${table}`)
      }
      const query = {
        insert: async (row) => {
          if (table !== 'messages') throw new Error(`unexpected insert into ${table}`)
          if (!notices.some((notice) => notice.id === row.id)) notices.push(structuredClone(row))
          return { data: null, error: null }
        },
        upsert: async (row) => {
          calls.push(['upsert_device', row])
          const existing = devices.find((device) => device.device_id === row.device_id)
          if (existing) Object.assign(existing, structuredClone(row))
          else devices.push(structuredClone(row))
          return { data: null, error: null }
        },
        select: () => query,
        update: (value) => { patch = value; return query },
        eq: (key, value) => { filters.push([key, value]); return query },
        in: (key, value) => { filters.push([key, value]); return query },
        order: () => query,
        single: async () => { const answer = result(); return { ...answer, data: Array.isArray(answer.data) ? answer.data[0] : answer.data } },
        maybeSingle: async () => { const answer = result(); return { ...answer, data: Array.isArray(answer.data) ? answer.data[0] ?? null : answer.data } },
        then: (success, failure) => Promise.resolve(result()).then(success, failure),
      }
      return query
    },
  }
  const cloud = {
    identity, chat: { from: identity.from }, root: 'https://test.invalid', client: {},
    start: async () => undefined, close: async () => undefined, configure: async () => undefined, token: async () => 'test-token',
    modelAccess: async (body) => {
      calls.push(['model-access', body])
      if (body.action === 'catalog') return { models: [{ id: 'free', display_name: 'Test model', enabled: true, protocols: ['openai-chat-completions'] }] }
      if (body.action === 'issue') return { session_id: randomUUID(), relay_url: 'https://model.invalid/v1', token: 'private-turn-token', model: 'model-alias', protocol: 'openai-chat-completions', expires_at: new Date(Date.now() + 600_000).toISOString() }
      return {}
    },
    rpc: async (schema, name, args) => {
      calls.push([name, args])
      if (name === 'start_agent_provision_operation') {
        provision ??= { ...args.p_blueprint.members[0], id: args.p_blueprint.members[0].provision_id, operation_id: args.p_operation_id, member_key: 'single', device_id: deviceId, phase: 'queued', project_path: null, avatar: null, special_focus: null }
        return { id: args.p_operation_id }
      }
      if (name === 'claim_provision_slots') { if (provision.phase !== 'queued') return []; provision.phase = 'preparing'; return [provision] }
      if (name === 'prepare_agent_provision') {
        const commandId = randomUUID()
        provision = { ...provision, phase: 'awaiting_terminal', agent_user_id: agentId, dm_chat_id: chatId, create_command_id: commandId }
        commands.push({ id: commandId, type: 'agent.create', status: 'pending', created_at: new Date().toISOString(), payload: { agent_user_id: agentId, display_name: '手机 Agent', agent_type: 'pi', greeting_chat_id: chatId, model: 'platform:free' } })
        return provision
      }
      if (name === 'settle_agent_provision_terminal') { assert.equal(commands.find((command) => command.id === provision.create_command_id).status, 'done'); provision.phase = 'ready'; return provision }
      if (name === 'complete_agent_provision') { assert.equal(provision.phase, 'ready'); provision.phase = 'completed'; return { already: false } }
      if (name === 'pull_agent_inbox_v2') return inboxRows
      if (name === 'mark_read_on_deliver') { inboxRows.splice(inboxRows.findIndex((row) => row.id === args.p_message_id), 1); return {} }
      if (name === 'chat_facts') return [{ kind: 'dm', group_prompt: null, source_chat_id: null }]
      if (name === 'list_member_ids') return [{ user_id: agentId }, { user_id: ownerId }]
      if (name === 'add_group_agent') return { chat_id: args.p_chat_id, status: 'pending_approval' }
      if (name === 'send_message_idempotent') { if (!messages.some((message) => message.p_message_id === args.p_message_id)) messages.push(args); return [{ id: args.p_message_id }] }
      throw new Error(`unexpected ${schema} RPC ${name}`)
    },
  }
  return { cloud, commands, calls, messages, notices, inboxRows, devices, users }
}

async function fixture(runTurn, { nativeCall = async () => ({ ok: true }), cancelTurn = () => true, actionFactory = async () => ({ tools: () => [], confirmationForMessage: () => null, cancel: async () => undefined }), prepare = async () => undefined, onRpcStart = () => undefined, onSessionReply = () => undefined, preparationOptions = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gugu-phone-host-'))
  const previousHome = process.env.GUGU_AGENT_HOME
  process.env.GUGU_AGENT_HOME = root
  const fake = fakeCloud()
  const events = []
  const sessionReplies = []
  let authChanged
  let connectivityChanged
  const config = { ownerId, deviceId, installId, supabaseUrl: 'https://test.invalid', supabaseAnonKey: 'public', accessToken: 'private', refreshToken: 'private', grants: { calendar: true, photos: true }, deviceRow: { device_id: deviceId, user_id: ownerId, label: '测试手机', hostname: 'test-phone', platform: 'android', capabilities: { actions: { v: 1, actions: [] } } } }
  await prepare({ root, ...fake, events })
  const host = await startPhoneAgentHost(config, {
    runTurn, cancelTurn, emit: (event) => events.push(event), nativeCall, preparationOptions,
    cloudFactory: (_config, onSession) => { authChanged = onSession; return fake.cloud },
    actionFactory,
    resolveIdentities: async () => new Map([[ownerId, { displayName: '主人', guguNumber: 1, isAgent: false }], [agentId, { displayName: '手机 Agent', guguNumber: 2, isAgent: true }]]),
    rpcFactory: async (handlers) => {
      connectivityChanged = handlers.onConnectivity
      await onRpcStart({ ...handlers, events, ...fake })
      return { close: async () => undefined, requester: {
        call: async (_device, _type, body) => {
          if (body.channel === 'agentSession.locate') return { result: { value: { session_ids: body.args[1].session_ids } } }
          sessionReplies.push(body)
          await onSessionReply(body)
          return { result: { value: { recipients: [{ to: `session:${body.args[1].session_ids[0]}`, status: 'delivered', message_id: randomUUID() }] } } }
        },
      } }
    },
  })
  return { ...fake, root, config, host, events, sessionReplies, authChanged: (...args) => authChanged(...args), connectivityChanged: (connected) => connectivityChanged(connected), async close() { await host.close(); if (previousHome === undefined) delete process.env.GUGU_AGENT_HOME; else process.env.GUGU_AGENT_HOME = previousHome; await rm(root, { recursive: true }) } }
}
const until = async (predicate, events) => {
  const deadline = Date.now() + 5_000
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`expected turn did not settle: ${JSON.stringify(events.filter((event) => ['turn_failed', 'host_log'].includes(event.type)))}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const untilNetworkQueued = (fx) => until(async () => {
  const journal = JSON.parse(await readFile(join(fx.root, 'hosts', ownerId, 'host.json'), 'utf8'))
  return !fx.host.state().execution && Object.values(journal.jobs).some(job => job.status === 'queued' && job.networkWait)
}, fx.events)

test('a first preparation request failure recovers in the same task and returns exactly one result to the assistant', async () => {
  let issues = 0, turns = 0
  const caller = { sessionId: 'edb18513-6477-4c4d-8766-049227046427', deviceId: 'acceptance-computer', name: '个人助理', harness: 'pi', platformModel: 'platform:free', transport: 'acp' }
  const fx = await fixture(async (command, hooks) => {
    turns++
    await hooks.extraTools.find(tool => tool.name === 'session_message').execute('one-result', { to: [`session:${caller.sessionId}`], text: '1073', reply_to_message_id: command.prompt.match(/msg="(msg:[^"]+)/)[1] })
    return { status: 'done', text: '结果已交回' }
  }, { prepare: ({ cloud, devices }) => {
    devices.push({ device_id: caller.deviceId, user_id: ownerId, label: '验收电脑', hostname: 'acceptance-computer', platform: 'darwin', status: 'online', last_seen_at: new Date().toISOString(), capabilities: { runtimes: ['pi'], host_runtime_capability: 1 } })
    const access = cloud.modelAccess
    cloud.modelAccess = body => {
      if (body.action === 'issue' && ++issues === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('private endpoint'), { code: 'ENOTFOUND' }) })
      return access(body)
    }
  } })
  try {
    await fx.host.invoke('agentSession.spawn', [caller, { action: 'spawn', harness: 'pi', prompt: '算 37 乘 29，把结果交给我' }], 'preparation-recovery')
    await until(() => issues === 1, fx.events)
    assert.equal(fx.host.state().execution.phase, 'preparing')
    assert.equal(fx.host.state().sessions[0].status, 'working')
    await until(() => fx.host.state().sessions[0]?.lastJobStatus === 'done', fx.events)
    assert.equal(issues, 2)
    assert.equal(turns, 1)
    assert.equal(fx.sessionReplies.length, 1)
    assert.equal(fx.sessionReplies[0].args[1].text, '1073')
    assert.equal(fx.events.some(event => event.type === 'turn_failed'), false)
    const journal = JSON.parse(await readFile(join(fx.root, 'hosts', ownerId, 'host.json'), 'utf8'))
    assert.equal(Object.values(journal.jobs)[0].preparationFailures[0].code, 'ENOTFOUND')
    assert.doesNotMatch(JSON.stringify(journal.requestFailures), /private endpoint|https/)
  } finally { await fx.close() }
})

test('two minutes offline preserves the same queued task; a successful heartbeat resumes it without any failure notice', async () => {
  let time = 0, online = true, turns = 0, issues = 0
  const caller = { sessionId: 'edb18513-6477-4c4d-8766-049227046427', deviceId: 'acceptance-computer', name: '个人助理', harness: 'pi', platformModel: 'platform:free', transport: 'acp' }
  const fx = await fixture(async (command, hooks) => {
    turns++
    await hooks.extraTools.find(tool => tool.name === 'session_message').execute('one-result', { to: [`session:${caller.sessionId}`], text: '1073' })
    return { status: 'done', text: '结果已交回' }
  }, { preparationOptions: { now: () => time, wait: async ms => { time += ms }, random: () => 1 }, prepare: ({ cloud, devices }) => {
    devices.push({ device_id: caller.deviceId, user_id: ownerId, label: '验收电脑', hostname: 'acceptance-computer', platform: 'darwin', status: 'online', last_seen_at: new Date().toISOString(), capabilities: { runtimes: ['pi'], host_runtime_capability: 1 } })
    const access = cloud.modelAccess
    cloud.modelAccess = body => {
      if (body.action === 'issue') {
        issues++
        if (time < 120_000) throw new TypeError('fetch failed', { cause: Object.assign(new Error('offline'), { code: 'ENETUNREACH' }) })
      }
      return access(body)
    }
    const from = cloud.identity.from
    cloud.identity.from = table => {
      const query = from(table)
      const upsert = query.upsert
      query.upsert = (...args) => online ? upsert(...args) : Promise.reject(new TypeError('fetch failed'))
      return query
    }
  } })
  try {
    await fx.host.invoke('agentSession.spawn', [caller, { action: 'spawn', harness: 'pi', prompt: '计算并交回' }], 'two-minute-outage')
    await untilNetworkQueued(fx)
    assert.equal(time, 45_000)
    assert.equal(fx.host.state().sessions[0].status, 'working')
    const journal = JSON.parse(await readFile(join(fx.root, 'hosts', ownerId, 'host.json'), 'utf8'))
    const jobId = Object.keys(journal.jobs)[0]
    assert.equal(journal.jobs[jobId].failureNotice, undefined)
    online = false
    time = 120_000
    await assert.rejects(fx.host.handle({ type: 'configure', config: fx.config }), /fetch failed/)
    assert.equal(issues, 9)
    assert.equal(turns, 0)
    online = true
    await fx.host.handle({ type: 'configure', config: fx.config })
    await until(() => fx.host.state().sessions[0]?.lastJobStatus === 'done', fx.events)
    const completed = JSON.parse(await readFile(join(fx.root, 'hosts', ownerId, 'host.json'), 'utf8'))
    assert.deepEqual(Object.keys(completed.jobs), [jobId])
    assert.equal(turns, 1)
    assert.equal(fx.sessionReplies.length, 1)
    assert.equal(fx.sessionReplies[0].args[1].text, '1073')
    assert.equal(fx.events.some(event => event.type === 'turn_failed'), false)
    assert.equal(completed.jobs[jobId].failureNotice, undefined)
  } finally { await fx.close() }
})

test('a process restart retains the queued network wait and resumes the original task once', async () => {
  let time = 0, journal, turns = 0
  const caller = { sessionId: 'edb18513-6477-4c4d-8766-049227046427', deviceId: 'acceptance-computer', name: '个人助理', harness: 'pi', platformModel: 'platform:free', transport: 'acp' }
  const fx = await fixture(async () => { throw new Error('must wait for networking') }, {
    preparationOptions: { now: () => time, wait: async ms => { time += ms }, random: () => 1 },
    prepare: ({ cloud }) => {
      const access = cloud.modelAccess
      cloud.modelAccess = body => body.action === 'issue' ? Promise.reject(new TypeError('fetch failed')) : access(body)
    },
  })
  try {
    await fx.host.invoke('agentSession.spawn', [caller, { action: 'spawn', harness: 'pi', prompt: '恢复后只做一次' }], 'durable-network-wait')
    await untilNetworkQueued(fx)
    journal = JSON.parse(await readFile(join(fx.root, 'hosts', ownerId, 'host.json'), 'utf8'))
    assert.equal(Object.values(journal.jobs)[0].failureNotice, undefined)
  } finally { await fx.close() }
  time = 120_000
  const recovered = await fixture(async (command, hooks) => {
    turns++
    await hooks.extraTools.find(tool => tool.name === 'session_message').execute('one-result', { to: [`session:${caller.sessionId}`], text: '已完成' })
    return { status: 'done', text: '已交回' }
  }, { preparationOptions: { now: () => time }, prepare: async ({ root, devices }) => {
    const directory = join(root, 'hosts', ownerId)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'host.json'), JSON.stringify(journal))
    devices.push({ device_id: caller.deviceId, user_id: ownerId, label: '验收电脑', hostname: 'acceptance-computer', platform: 'darwin', status: 'online', last_seen_at: new Date().toISOString(), capabilities: { runtimes: ['pi'], host_runtime_capability: 1 } })
  } })
  try {
    await until(() => recovered.host.state().sessions[0]?.lastJobStatus === 'done', recovered.events).catch(error => {
      throw new Error(`${error.message}; recovery state: ${JSON.stringify(recovered.host.state())}; backoff: ${JSON.stringify(journal.preparationBackoff)}`)
    })
    assert.equal(turns, 1)
    assert.equal(recovered.sessionReplies.length, 1)
    assert.equal(recovered.events.some(event => event.type === 'turn_failed'), false)
    const completed = JSON.parse(await readFile(join(recovered.root, 'hosts', ownerId, 'host.json'), 'utf8'))
    assert.deepEqual(Object.keys(completed.jobs), Object.keys(journal.jobs))
  } finally { await recovered.close() }
})

test('an expired network wait is disclosed once; a lost delivery acknowledgment survives restart with the same identity', async () => {
  const caller = { sessionId: 'edb18513-6477-4c4d-8766-049227046427', deviceId: 'acceptance-computer', name: '个人助理', harness: 'pi', platformModel: 'platform:free', transport: 'acp' }
  let attempts = 0, turns = 0, journal, original, time = 0
  const fx = await fixture(async () => { turns++; throw new Error('must not run the model') }, {
    prepare: ({ cloud }) => {
      const access = cloud.modelAccess
      cloud.modelAccess = body => {
        if (body.action === 'issue') { attempts++; throw new TypeError('fetch failed', { cause: Object.assign(new Error('private endpoint'), { code: 'ECONNRESET' }) }) }
        return access(body)
      }
    },
    onSessionReply: () => { throw new Error('acknowledgment lost') },
    preparationOptions: { now: () => time, wait: async ms => { time += ms }, random: () => 1 },
  })
  try {
    await fx.host.invoke('agentSession.spawn', [caller, { action: 'spawn', harness: 'pi', prompt: '执行一次任务' }], 'preparation-exhausted')
    await untilNetworkQueued(fx)
    assert.equal(time, 45_000)
    assert.equal(fx.sessionReplies.length, 0)
    time += 30 * 60_000 + 1
    await fx.host.handle({ type: 'configure', config: fx.config })
    await until(async () => {
      const state = JSON.parse(await readFile(join(fx.root, 'hosts', ownerId, 'host.json'), 'utf8'))
      return Object.values(state.jobs).some(job => job.failureNotice?.nextAttemptAt)
    }, fx.events)
    assert.equal(attempts, 9)
    assert.equal(turns, 0)
    assert.equal(fx.sessionReplies.length, 1)
    original = fx.sessionReplies[0].args[1]
    assert.equal(original.text, '这次手机任务没能完成，网络连接反复中断。')
    assert.doesNotMatch(original.text, /job|fetch|重发|[\da-f]{8}-/)
    journal = JSON.parse(await readFile(join(fx.root, 'hosts', ownerId, 'host.json'), 'utf8'))
    const job = Object.values(journal.jobs)[0]
    assert.equal(job.status, 'failed')
    assert.equal(job.error, original.text)
    assert.equal(job.failureNotice.status, 'pending')
    job.failureNotice.nextAttemptAt = new Date(0).toISOString() // The recovery interval has elapsed on restart.
  } finally { await fx.close() }
  const recovered = await fixture(async () => { turns++; throw new Error('must not replay the failed task') }, { prepare: async ({ root }) => {
    const directory = join(root, 'hosts', ownerId)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'host.json'), JSON.stringify(journal))
  } })
  try {
    await until(() => recovered.sessionReplies.length === 1, recovered.events)
    assert.deepEqual(recovered.sessionReplies[0].args[1], original)
    assert.equal(turns, 0)
    await until(async () => Object.values(JSON.parse(await readFile(join(recovered.root, 'hosts', ownerId, 'host.json'), 'utf8')).jobs)[0].failureNotice.status === 'sent', recovered.events)
    assert.equal(recovered.sessionReplies.length, 1)
  } finally { await recovered.close() }
})

async function recordTurn(command, hooks, text) {
  const directory = join(process.env.GUGU_AGENT_HOME, command.sessionId, command.contextEpoch, 'sessions')
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'actual-session.jsonl')
  let previous = null
  try { const entries = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse); previous = entries.at(-1).id } catch (error) { if (error.code !== 'ENOENT') throw error }
  const at = Date.now()
  const userId = randomUUID()
  const agentMessageId = randomUUID()
  await hooks.onRecord({ path, providerSessionId: command.sessionId })
  const user = { type: 'message', id: userId, parentId: previous, timestamp: new Date(at).toISOString(), message: { role: 'user', timestamp: at, content: command.prompt } }
  const answer = { type: 'message', id: agentMessageId, parentId: userId, timestamp: new Date(at + 1).toISOString(), message: { role: 'assistant', timestamp: at + 1, content: [{ type: 'text', text }], stopReason: 'stop' } }
  const lines = [user, answer].map((entry) => `${JSON.stringify(entry)}\n`).join('')
  if (previous) await appendFile(path, lines)
  else await writeFile(path, `${JSON.stringify({ type: 'session', version: 3, id: command.sessionId, cwd: directory, timestamp: new Date(at).toISOString() })}\n${lines}`)
  hooks.emit({ type: 'pi_live', kind: 'committed', id: `phone-input:${command.jobId}`, recordId: userId })
}

test('a local create runs its first input directly and reads the actual Pi result without any DM messages', async () => {
  const fx = await fixture(async (command, hooks) => {
    assert.equal(command.prompt, '直接在任务页查日程')
    assert.match(hooks.systemPrompt, /本轮来源是 task/)
    await recordTurn(command, hooks, '任务页真实结果')
    return { status: 'done', text: '任务页真实结果' }
  })
  try {
    const created = await fx.host.invoke('sessionTimeline.sessionCreate', [{ harness: 'pi', prompt: '直接在任务页查日程' }], 'direct-task-create')
    await until(() => fx.host.state().sessions[0]?.lastJobStatus === 'done', fx.events)
    assert.deepEqual(fx.messages, [])
    assert.equal(fx.calls.some(([name]) => name === 'send_message_idempotent'), false)
    const snapshot = await fx.host.invoke('sessionTimeline.sessionSnapshot', [{ conversationId: created.conversationId }])
    assert.match(JSON.stringify(snapshot.turns), /任务页真实结果/)
    assert.match(JSON.stringify(snapshot.turns), /直接在任务页查日程/)
    assert.equal(snapshot.turns[0].outcome.kind, 'done')
    const list = await fx.host.invoke('sessionTimeline.sessionsList', [])
    assert.equal(list.projects[0].name, '手机任务')
    assert.equal(list.sessions[0].supported, true)
  } finally { await fx.close() }
})

test('a newly created task persists its first context before admission and is readable while Pi has no record yet', async () => {
  let provisioningAtCompletion
  const completionReached = new Promise((resolve) => { provisioningAtCompletion = resolve })
  let releaseCompletion
  const completionGate = new Promise((resolve) => { releaseCompletion = resolve })
  let releaseModel
  const modelGate = new Promise((resolve) => { releaseModel = resolve })
  let runningContext
  const fx = await fixture(async (command, hooks) => {
    runningContext = command.contextEpoch
    await recordTurn(command, hooks, '首轮已完成')
    return { status: 'done', text: '首轮已完成' }
  })
  const originalRpc = fx.cloud.rpc
  fx.cloud.rpc = async (schema, name, args) => {
    if (name === 'complete_agent_provision') { provisioningAtCompletion(); await completionGate }
    return originalRpc(schema, name, args)
  }
  const originalAccess = fx.cloud.modelAccess
  fx.cloud.modelAccess = async (body) => {
    if (body.action === 'issue') await modelGate
    return originalAccess(body)
  }
  let creating
  try {
    creating = fx.host.invoke('sessionTimeline.sessionCreate', [{ harness: 'pi', prompt: '首次创建后直接进入这条任务' }], randomUUID())
    await completionReached
    // This is before the initial input exists and before drain can initialize a turn. The
    // first context must already be durable, or the concurrent create summary can read the
    // empty epoch and reject its own result when the first job initializes it during IO.
    const beforeAdmission = JSON.parse(await readFile(join(fx.root, 'hosts', ownerId, 'host.json'), 'utf8'))
    const firstContext = beforeAdmission.agents[agentId].contextEpoch
    assert.match(firstContext ?? '', /^[0-9a-f-]{36}$/i)
    assert.deepEqual(beforeAdmission.jobs, {})
    releaseCompletion()
    const created = await creating
    assert.equal(created.session.supported, true, created.session.unsupportedReason)
    const initial = await fx.host.invoke('sessionTimeline.sessionSnapshot', [{ conversationId: created.conversationId }])
    assert.match(JSON.stringify(initial), /首次创建后直接进入这条任务/)
    assert.equal(runningContext, undefined)
    releaseModel()
    await until(() => fx.host.state().sessions[0]?.lastJobStatus === 'done', fx.events)
    assert.equal(runningContext, firstContext)
    assert.equal(fx.commands.length, 1)
  } finally {
    releaseCompletion(); releaseModel()
    await creating?.catch(() => undefined)
    await fx.close()
  }
})

test('notification cancellation matches the active job exactly and preserves the next queued task', async () => {
  let releaseIssue
  const issueGate = new Promise((resolve) => { releaseIssue = resolve })
  let releaseTurn
  const turnGate = new Promise((resolve) => { releaseTurn = resolve })
  let issues = 0
  let cancellations = 0
  const fx = await fixture(async (command, hooks) => {
    hooks.emit({ type: 'pi_live', kind: 'phase', phase: 'model' })
    await turnGate
    await recordTurn(command, hooks, '排队任务已完成')
    return { status: 'done', text: '排队任务已完成' }
  }, { cancelTurn: () => { cancellations++; return true } })
  const originalAccess = fx.cloud.modelAccess
  fx.cloud.modelAccess = async (body) => {
    if (body.action === 'issue' && ++issues === 1) await issueGate
    return originalAccess(body)
  }
  try {
    const created = await fx.host.invoke('sessionTimeline.sessionCreate', [{ harness: 'pi', prompt: '第一件任务' }], randomUUID())
    await until(() => issues === 1 && fx.host.state().execution?.phase === 'preparing', fx.events)
    const first = fx.host.state().execution
    const queued = await fx.host.invoke('sessionTimeline.sessionSend', [{ conversationId: created.conversationId, text: '下一件排队任务', clientRequestId: randomUUID() }], randomUUID())
    assert.equal(queued.accepted, true)
    await fx.host.handle({ type: 'cancel', ownerId, sessionId: first.sessionId, jobId: first.jobId })
    assert.equal(fx.host.state().execution.phase, 'stopping')
    assert.equal(cancellations, 1)
    releaseIssue()
    await until(() => fx.host.state().execution?.jobId !== first.jobId && fx.host.state().execution?.phase === 'model', fx.events)
    const second = fx.host.state().execution
    await fx.host.handle({ type: 'cancel', ownerId, sessionId: first.sessionId, jobId: first.jobId })
    assert.deepEqual(fx.host.state().execution, second)
    assert.equal(cancellations, 1)
    releaseTurn()
    await until(() => fx.host.state().sessions[0]?.lastJobStatus === 'done' && fx.host.state().execution === null, fx.events)
    const snapshot = await fx.host.invoke('sessionTimeline.sessionSnapshot', [{ conversationId: created.conversationId }])
    assert.match(JSON.stringify(snapshot.turns), /排队任务已完成/)
  } finally { releaseIssue(); releaseTurn(); await fx.close() }
})

test('remote session_stop waits for Pi to end and returns its final state with queued follow-ups cancelled', async () => {
  let releaseTurn
  const turnGate = new Promise(resolve => { releaseTurn = resolve })
  let entered = false
  let cancelled = false
  const fx = await fixture(async () => {
    entered = true
    await turnGate
    return { status: 'cancelled', text: '' }
  }, { cancelTurn: () => { cancelled = true; return true } })
  let stopping
  try {
    const created = await fx.host.invoke('sessionTimeline.sessionCreate', [{ harness: 'pi', prompt: '产生一份文件' }], randomUUID())
    await until(() => entered, fx.events)
    const sessionId = fx.host.state().sessions[0].sessionId
    await fx.host.invoke('sessionTimeline.sessionSend', [{ conversationId: created.conversationId, text: '追加要求', clientRequestId: randomUUID() }], randomUUID())
    let returned = false
    stopping = fx.host.invoke('agentSession.stop', [{ sessionId: randomUUID(), deviceId: 'cloud-device' }, { action: 'stop', session_id: sessionId }])
      .then(result => { returned = true; return result })
    await until(() => cancelled && fx.host.state().execution?.phase === 'stopping', fx.events)
    assert.equal(returned, false)
    releaseTurn()
    const result = await stopping
    assert.equal(result.session_id, sessionId)
    assert.equal(result.status, 'idle')
    assert.equal(result.detail, 'plain')
    assert.equal(result.cancelled, true)
    assert.equal(result.settled, true)
    assert.equal(fx.host.state().execution, null)
    const journal = JSON.parse(await readFile(join(fx.root, 'hosts', ownerId, 'host.json'), 'utf8'))
    assert.equal(Object.values(journal.jobs).length, 2)
    assert.ok(Object.values(journal.jobs).every(job => job.status === 'cancelled'))
    assert.deepEqual(fx.messages, [])
    assert.deepEqual(journal.artifacts ?? {}, {})
  } finally { releaseTurn(); await stopping?.catch(() => undefined); await fx.close() }
})

test('the native task page approves a fixed phone operation once while a forged remote UI source is refused', async () => {
  let turns = 0
  const writes = []
  const fx = await fixture(async (command, hooks) => {
    turns++
    if (turns === 1) {
      const result = await hooks.extraTools.find((tool) => tool.name === 'phone_call').execute('calendar-create', { name: 'calendar.events.create', args: { title: '任务页确认日程', start: '2026-10-21T14:00:00+08:00', end: '2026-10-21T14:30:00+08:00' } })
      assert.equal(result.details.code, 'needs_confirmation')
    }
    await recordTurn(command, hooks, turns === 1 ? '请在任务页确认本次操作' : '主人确认后已创建日程')
    return { status: 'done', text: turns === 1 ? '请在任务页确认本次操作' : '主人确认后已创建日程' }
  }, { actionFactory: createPhoneActionRuntime, nativeCall: async (name, args, _signal, metadata) => {
    if (name === 'permissions.check' || name === 'permissions.preflight') return { ok: true }
    writes.push({ name, args, metadata }); return { ok: true, data: { event_id: '42' }, permissionRequirements: { permissions: ['android.permission.WRITE_CALENDAR'], mediaRefs: [] } }
  } })
  try {
    const created = await fx.host.invoke('sessionTimeline.sessionCreate', [{ harness: 'pi', prompt: '创建日程' }], randomUUID())
    await until(() => fx.host.state().sessions[0]?.status === 'needs_user', fx.events)
    const snapshot = await fx.host.invoke('sessionTimeline.sessionSnapshot', [{ conversationId: created.conversationId }])
    assert.equal(snapshot.settlements.length, 1)
    assert.equal(snapshot.settlements[0].state, 'pending')
    const input = { conversationId: created.conversationId, itemId: snapshot.settlements[0].itemId, kind: 'permission', optionId: 'approve', by: ownerId, source: 'native-ui' }
    await assert.rejects(fx.host.invoke('sessionTimeline.sessionRespond', [input], randomUUID()), /不能代替主人/)
    assert.equal(writes.length, 0)
    const id = randomUUID()
    await fx.host.handle({ type: 'host_call', ownerId, source: 'native-ui', id, channel: 'sessionTimeline.sessionRespond', args: [input] })
    assert.equal(fx.events.find((event) => event.type === 'host_result' && event.id === id).result.accepted, true)
    await until(() => writes.length === 1 && fx.host.state().sessions[0]?.lastJobStatus === 'done', fx.events)
    assert.equal(writes[0].args.args.title, '任务页确认日程')
    assert.equal(writes[0].metadata.approval.ownerId, ownerId)
    const repeated = randomUUID()
    await fx.host.handle({ type: 'host_call', ownerId, source: 'native-ui', id: repeated, channel: 'sessionTimeline.sessionRespond', args: [input] })
    assert.equal(fx.events.find((event) => event.type === 'host_result' && event.id === repeated).result.accepted, false)
    assert.equal(writes.length, 1)
    assert.deepEqual(fx.messages, [])
    const completed = await fx.host.invoke('sessionTimeline.sessionSnapshot', [{ conversationId: created.conversationId }])
    assert.equal(completed.settlements[0].state, 'resolved')
    assert.match(JSON.stringify(completed.turns), /主人确认后已创建日程/)
  } finally { await fx.close() }
})

test('real phone device IDs register honestly, and remote spawn completes the canonical saga before returning a durable session', async () => {
  let turn
  const fx = await fixture(async (command, hooks) => {
    turn = command
    assert.match(command.prompt, /route="session-direct"/)
    const target = hooks.extraTools.find((tool) => tool.name === 'session_message')
    await target.execute('reply-call', { to: ['session:edb18513-6477-4c4d-8766-049227046427'], text: '手机已完成', reply_to_message_id: command.prompt.match(/msg="(msg:[^"]+)/)[1] })
    return { status: 'done', text: '已通过咕咕回复' }
  })
  try {
    const caller = { sessionId: 'edb18513-6477-4c4d-8766-049227046427', deviceId: `phone-${randomUUID()}-${ownerId}`, name: '云端 Agent', harness: 'pi', platformModel: 'platform:free', transport: 'acp' }
    fx.devices.push({ device_id: caller.deviceId, label: 'Cloud', hostname: 'cloud', user_id: ownerId, platform: 'linux', status: 'online', last_seen_at: new Date().toISOString(), capabilities: { terminals: [], runtimes: ['pi'], host_runtime_capability: 1 } })
    const action = { action: 'spawn', harness: 'pi', prompt: '查今天的日程' }
    const result = await fx.host.invoke('agentSession.spawn', [caller, action], 'durable-spawn-request')
    assert.equal(result.agent_user_id, agentId)
    assert.equal(result.provider_id, 'pi')
    assert.equal(fx.commands.length, 1)
    assert.equal(fx.commands[0].status, 'done')
    assert.equal((await fx.host.invoke('agentSession.spawn', [caller, action], 'durable-spawn-request')).session_id, result.session_id)
    assert.equal(fx.commands.length, 1)
    await until(() => fx.sessionReplies.length > 0, fx.events)
    assert.equal(turn.sessionId, result.session_id)
    assert.equal(fx.sessionReplies.length, 1)
    const registrations = fx.calls.filter(([name]) => name === 'upsert_device').map(([, row]) => row)
    assert.equal(registrations[0].device_id, deviceId)
    assert.equal(registrations[0].capabilities.host_runtime_capability, 0)
    assert.equal(registrations.at(-1).capabilities.host_runtime_capability, 1)
    assert.equal(fx.host.state().lastHeartbeatAt > 0, true)
    assert.deepEqual(await fx.host.invoke('agentSession.locate', [caller, { action: 'locate', session_ids: [result.session_id, randomUUID()] }], randomUUID()), { session_ids: [result.session_id] })
  } finally { await fx.close() }
})

test('a local initial message enters the shared inbox envelope and replies with its own identity and stable message ID', async () => {
  const fx = await fixture(async (command, hooks) => {
    if (!command.prompt.includes('gugu_delivery')) return { status: 'done', text: '[NO_REPLY]' }
    assert.match(command.prompt, /route="chat"/)
    assert.match(command.prompt, new RegExp(chatId))
    const tool = hooks.extraTools.find((item) => item.name === 'message_send')
    const args = { chat_id: chatId, text: '日历结果', to_user_ids: [`user:${ownerId}`], reply_to_message_id: command.prompt.match(/msg="(msg:[^"]+)/)[1] }
    await tool.execute('call-one', args)
    await tool.execute('call-retry-with-different-tool-id', args)
    return { status: 'done', text: '已回复' }
  })
  const messageId = randomUUID()
  fx.inboxRows.push({ chat_id: chatId, chat_kind: 'dm', chat_public_id: null, id: messageId, seq: 1, sender_user_id: ownerId, sender_type: 'human', sender_display_name: '主人', content: '查今天的日程', content_type: 'text', to_user_ids: [agentId], is_whisper: false, file_item_id: null, file_version: null, file_blob_id: null, created_at: new Date().toISOString() })
  try {
    await fx.host.invoke('sessionTimeline.sessionCreate', [{ harness: 'pi', model: 'platform:free', prompt: '查今天的日程' }], 'local-create-request')
    await until(() => fx.messages.some((message) => message.p_sender_user_id === agentId), fx.events)
    const replies = fx.messages.filter((message) => message.p_sender_user_id === agentId)
    assert.equal(replies.length, 1)
    assert.equal(replies[0].p_reply_to_message_id, messageId)
    assert.deepEqual(replies[0].p_to_user_ids, [ownerId])
    const journal = JSON.parse(await readFile(join(fx.root, 'hosts', ownerId, 'host.json'), 'utf8'))
    assert.equal(journal.jobs[messageId].prompt.includes('gugu_delivery'), true)
    assert.equal(JSON.stringify(journal).includes('private-turn-token'), false)
  } finally { await fx.close() }
})

test('a failed chat turn is said in the chat as the desktop says it: one system notice, its fixed text, addressing no one', async () => {
  const fx = await fixture(async (command) => {
    if (!command.prompt.includes('gugu_delivery')) return { status: 'done', text: '[NO_REPLY]' }
    return { status: 'failed', text: '', error: 'simulated model failure with private detail' }
  })
  const messageId = randomUUID()
  // What is on disk at the moment the notice goes out: a failure said in the chat is already durable in the task.
  const onDiskAtNotice = []
  const from = fx.cloud.chat.from
  fx.cloud.chat.from = (table) => {
    const query = from(table)
    if (table !== 'messages') return query
    const insert = query.insert
    query.insert = async (row) => {
      onDiskAtNotice.push(JSON.parse(await readFile(join(fx.root, 'hosts', ownerId, 'host.json'), 'utf8')).jobs[messageId].status)
      return insert(row)
    }
    return query
  }
  fx.inboxRows.push({ chat_id: chatId, chat_kind: 'dm', chat_public_id: null, id: messageId, seq: 1, sender_user_id: ownerId, sender_type: 'human', sender_display_name: '主人', content: '你好', content_type: 'text', to_user_ids: [agentId], is_whisper: false, file_item_id: null, file_version: null, file_blob_id: null, created_at: new Date().toISOString() })
  try {
    await fx.host.invoke('sessionTimeline.sessionCreate', [{ harness: 'pi', model: 'platform:free', prompt: '你好' }], 'failing-chat-turn')
    await until(() => fx.notices.length > 0, fx.events)
    assert.equal(fx.notices.length, 1)
    assert.deepEqual(onDiskAtNotice, ['failed'])
    const [notice] = fx.notices
    assert.deepEqual(Object.keys(notice).sort(), ['chat_id', 'client_message_id', 'content', 'content_type', 'id', 'is_thread_root', 'sender_user_id', 'thread_root_id'])
    assert.equal(notice.chat_id, chatId)
    assert.equal(notice.sender_user_id, agentId)
    assert.equal(notice.content_type, 'system')
    assert.equal(notice.content, 'This reply could not be completed. Please try again later.')
    assert.equal(fx.messages.some((message) => message.p_sender_user_id === agentId), false)
    // The raw error stays in the task: failed job, its error.
    const journal = JSON.parse(await readFile(join(fx.root, 'hosts', ownerId, 'host.json'), 'utf8'))
    assert.equal(journal.jobs[messageId].status, 'failed')
    assert.match(journal.jobs[messageId].error, /simulated model failure/)
  } finally { await fx.close() }
})

test('a failed chat turn still posts its notice when saving the failure fails', async () => {
  let journalDirectory
  const fx = await fixture(async (command) => {
    if (!command.prompt.includes('gugu_delivery')) return { status: 'done', text: '[NO_REPLY]' }
    // The save before the notice cannot write: its directory is gone until the notice goes out.
    await rename(journalDirectory, `${journalDirectory}.away`)
    return { status: 'failed', text: '', error: 'simulated model failure' }
  })
  journalDirectory = join(fx.root, 'hosts', ownerId)
  const from = fx.cloud.chat.from
  fx.cloud.chat.from = (table) => {
    const query = from(table)
    if (table !== 'messages') return query
    const insert = query.insert
    query.insert = async (row) => { await rename(`${journalDirectory}.away`, journalDirectory); return insert(row) }
    return query
  }
  const messageId = randomUUID()
  fx.inboxRows.push({ chat_id: chatId, chat_kind: 'dm', chat_public_id: null, id: messageId, seq: 1, sender_user_id: ownerId, sender_type: 'human', sender_display_name: '主人', content: '你好', content_type: 'text', to_user_ids: [agentId], is_whisper: false, file_item_id: null, file_version: null, file_blob_id: null, created_at: new Date().toISOString() })
  try {
    await fx.host.invoke('sessionTimeline.sessionCreate', [{ harness: 'pi', model: 'platform:free', prompt: '你好' }], 'failing-save-turn')
    await until(() => fx.notices.length > 0, fx.events)
    assert.equal(fx.notices.length, 1)
    assert.equal(fx.notices[0].content_type, 'system')
  } finally { await fx.close() }
})

test('a failed turn on a whispered message posts only the fixed notice: no raw error reaches the chat', async () => {
  const fx = await fixture(async (command) => {
    if (!command.prompt.includes('gugu_delivery')) return { status: 'done', text: '[NO_REPLY]' }
    return { status: 'failed', text: '', error: 'simulated model failure with private detail' }
  })
  const messageId = randomUUID()
  fx.inboxRows.push({ chat_id: chatId, chat_kind: 'dm', chat_public_id: null, id: messageId, seq: 1, sender_user_id: ownerId, sender_type: 'human', sender_display_name: '主人', content: '悄悄话', content_type: 'text', to_user_ids: [agentId], is_whisper: true, file_item_id: null, file_version: null, file_blob_id: null, created_at: new Date().toISOString() })
  try {
    await fx.host.invoke('sessionTimeline.sessionCreate', [{ harness: 'pi', model: 'platform:free', prompt: '悄悄话' }], 'failing-whisper-turn')
    await until(() => fx.notices.length > 0, fx.events)
    assert.equal(fx.notices.length, 1)
    assert.doesNotMatch(JSON.stringify(fx.notices), /private detail|simulated/)
    assert.equal(fx.messages.some((message) => message.p_sender_user_id === agentId), false)
  } finally { await fx.close() }
})

test('an image attachment is durably admitted as safe metadata and acknowledged without fetching bytes during inbox delivery', async () => {
  let prompt
  const fx = await fixture(async (command, hooks) => {
    if (!command.prompt.includes('gugu_delivery')) return { status: 'done', text: '[NO_REPLY]' }
    prompt = command.prompt
    assert.match(prompt, /message_download_file/)
    assert.match(prompt, /calendar\.png/)
    assert.equal(prompt.includes('https://unreachable.invalid'), false)
    assert.equal(prompt.includes('[Image attached at local path:'), false)
    await hooks.extraTools.find((item) => item.name === 'message_send').execute('ack-image', { chat_id: chatId, text: '已收到附件消息', to_user_ids: [`user:${ownerId}`] })
    return { status: 'done', text: '已回复' }
  })
  const messageId = randomUUID()
  fx.inboxRows.push({ chat_id: chatId, chat_kind: 'dm', id: messageId, seq: 1, sender_user_id: ownerId, sender_type: 'human', content: '[附件] calendar.png (image/png)\n[URL] https://unreachable.invalid/image.png\n[Size] 42\n[Kind] image\n[Caption]\n收到后告诉我', content_type: 'attachment', to_user_ids: [agentId], file_item_id: null, file_version: null, file_blob_id: null, created_at: new Date().toISOString() })
  try {
    await fx.host.invoke('sessionTimeline.sessionCreate', [{ harness: 'pi', model: 'platform:free', prompt: '收附件' }], 'image-metadata')
    await until(() => fx.messages.some((message) => message.p_sender_user_id === agentId), fx.events)
    // In-memory completion precedes the journal's asynchronous save. Assert the admitted
    // message itself is durable, rather than racing a different/unsaved idle snapshot.
    await until(async () => JSON.parse(await readFile(join(fx.root, 'hosts', ownerId, 'host.json'), 'utf8')).jobs[messageId]?.status === 'done', fx.events)
    assert.match(prompt, new RegExp(`msg:${messageId}`))
    assert.equal(fx.inboxRows.length, 0)
    const journal = JSON.parse(await readFile(join(fx.root, 'hosts', ownerId, 'host.json'), 'utf8'))
    assert.equal(journal.jobs[messageId].status, 'done')
  } finally { await fx.close() }
})

test('revoking OS permission after a successful phone read prevents data from reaching the chat', async () => {
  const permissionChecks = []
  const fx = await fixture(async (_command, hooks) => {
    hooks.emit({ type: 'tool_start', name: 'phone_calendar_list' })
    hooks.emit({ type: 'tool_end', name: 'phone_calendar_list', result: { details: { ok: true } } })
    await hooks.extraTools.find((tool) => tool.name === 'message_send').execute('reply-call', { chat_id: chatId, text: 'private-calendar-fixture-9123', to_user_ids: [`user:${ownerId}`] })
    return { status: 'done', text: 'must not be delivered' }
  }, { nativeCall: async (name, args) => { permissionChecks.push([name, args]); return { ok: false, code: 'os_permission', message: '日历系统权限已撤销' } } })
  const messageId = randomUUID()
  fx.inboxRows.push({ chat_id: chatId, chat_kind: 'dm', id: messageId, seq: 1, sender_user_id: ownerId, sender_type: 'human', content: '查询日历', content_type: 'text', to_user_ids: [agentId], file_item_id: null, file_version: null, file_blob_id: null, created_at: new Date().toISOString() })
  try {
    await fx.host.invoke('sessionTimeline.sessionCreate', [{ harness: 'pi', prompt: '查询日历' }], 'revoke-in-flight')
    await until(() => fx.events.some((event) => event.type === 'turn_failed'), fx.events)
    assert.ok(permissionChecks.length > 0)
    for (const check of permissionChecks) assert.deepEqual(check, ['permissions.check', { groups: ['calendar'], requirements: [] }])
    assert.equal(fx.messages.some((message) => message.p_content.includes('private-calendar-fixture-9123')), false)
    const report = fx.calls.filter(([name]) => name === 'set_agent_runtime_state').at(-1)[1]
    assert.equal(typeof report.p_last_action_at, 'string')
  } finally { await fx.close() }
})

test('native hostCall creation reuses clientRequestId across transports and reports a real pending group approval', async () => {
  const fx = await fixture(async () => ({ status: 'done', text: '[NO_REPLY]' }))
  try {
    const clientRequestId = randomUUID()
    const args = [{ harness: 'pi', title: '手机 Agent', model: 'platform:free', prompt: '等任务', chatId: groupId, clientRequestId }]
    await fx.host.handle({ type: 'host_call', ownerId, id: randomUUID(), channel: 'sessionTimeline.sessionCreate', args })
    const first = fx.events.find((event) => event.type === 'host_result').result
    assert.deepEqual(first.birthGroup, { chatId: groupId, status: 'pending_approval' })
    assert.equal(first.agentUserId, agentId); assert.equal(first.chatId, chatId)
    await fx.host.handle({ type: 'host_call', ownerId, id: randomUUID(), channel: 'sessionTimeline.sessionCreate', args })
    assert.equal(fx.commands.length, 1)
    assert.equal(fx.calls.filter(([name]) => name === 'add_group_agent').length, 1)
    await assert.rejects(fx.host.invoke('sessionTimeline.sessionCreate', [{ ...args[0], prompt: 'changed intent' }], randomUUID()), /不能更换/)
  } finally { await fx.close() }
})

/** Model the official saga's phase gates, including the same-identity failed retry. */
function provisionCase(input = {}) {
  const options = { commandResults: ['done'], ...input }
  const calls = []
  const commands = []
  const store = { state: { requests: {}, agents: {} }, save: async () => { if (options.saveError) throw new Error('journal save failed') } }
  let row = null
  let identities = 0
  const read = () => ({ select: () => read(), eq: () => read(), single: async () => {
    calls.push(['read_provision', row?.phase])
    return { data: row ? structuredClone(row) : null, error: null }
  } })
  const cloud = {
    identity: { from: (table) => { assert.equal(table, 'agent_provisions'); return read() } },
    chat: { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { id: groupId, kind: 'group', status: options.groupStatus ?? 'active' }, error: null }) }) }) }) },
    rpc: async (_schema, name, args) => {
      calls.push([name, structuredClone(args)])
      if (name === 'start_agent_provision_operation') {
        row ??= { ...args.p_blueprint.members[0], id: args.p_blueprint.members[0].provision_id, operation_id: args.p_operation_id, device_id: deviceId, phase: 'queued', project_path: null, avatar: null, special_focus: null }
        if (options.startError) throw new Error('start reply lost')
        return { id: args.p_operation_id }
      }
      if (name === 'claim_provision_slots') {
        if (args.p_retry_provision_ids) {
          assert.deepEqual(args.p_retry_provision_ids, [row.id])
          assert.equal(row.phase, 'failed')
          assert.equal(row.agent_user_id, row.provisioned_agent_user_id)
        } else if (row.phase !== 'queued') return []
        row.phase = 'preparing'
        return [structuredClone(row)]
      }
      if (name === 'prepare_agent_provision') {
        assert.equal(row.phase, 'preparing')
        if (row.agent_user_id) assert.equal(commands.find((command) => command.id === row.create_command_id).status, 'error')
        else { identities++; row.agent_user_id = agentId; row.provisioned_agent_user_id = agentId; row.dm_chat_id = chatId }
        const command = { id: randomUUID(), status: 'pending', agentUserId: row.agent_user_id }
        commands.push(command)
        row.create_command_id = command.id
        row.phase = 'awaiting_terminal'
        return structuredClone(row)
      }
      if (name === 'settle_agent_provision_terminal') {
        const status = commands.find((command) => command.id === row.create_command_id).status
        assert.ok(status === 'done' || status === 'error')
        row.phase = status === 'done' ? 'ready' : 'failed'
        row.error = status === 'error' ? 'agent_create_command_error' : null
        return structuredClone(row)
      }
      if (name === 'complete_agent_provision') { assert.ok(['ready', 'completed'].includes(row.phase)); row.phase = 'completed'; return {} }
      if (name === 'send_message_idempotent') return {}
      throw new Error(`unexpected provision RPC ${name}`)
    },
  }
  const originalFrom = cloud.identity.from
  cloud.identity.from = (table) => table !== 'gugu_device_commands' ? originalFrom(table)
    : { select: () => ({ eq: (_key, id) => ({ single: async () => ({ data: commands.find((command) => command.id === id), error: null }) }) }) }
  const provision = createPhoneProvisioner({ ownerId, deviceId, projectId: 'phone-project', root: '/private/phone', cloud, store,
    models: { resolve: async () => { if (options.modelError) throw new Error('model no longer available'); return 'free' } },
    tick: async () => {
      const command = commands.find((entry) => entry.id === row.create_command_id)
      if (command.status !== 'pending') return
      command.status = options.commandResults.shift() ?? 'done'
      if (command.status === 'done') store.state.agents[agentId] = { agentUserId: agentId, sessionId: 'phone-session', chatId }
    },
    admit: async () => undefined, inbox: async () => undefined, publish: () => undefined,
    snapshot: (agent) => ({ session_id: agent.sessionId, agent_user_id: agent.agentUserId, chat_id: agent.chatId }),
  })
  return { provision, options, calls, commands, store, get row() { return row }, get identities() { return identities } }
}

test('phone provision retry regrants only a durable failed member and keeps its operation, identity and DM', async () => {
  const fx = provisionCase({ commandResults: ['error', 'done'] })
  const clientRequestId = randomUUID()
  const action = { clientRequestId, harness: 'pi', prompt: 'retry the same task' }
  await assert.rejects(fx.provision(randomUUID(), action), /agent_create_command_error/)
  assert.equal(fx.row.phase, 'failed')
  const saved = structuredClone(fx.store.state.requests[`client:${clientRequestId}`])
  const result = await fx.provision(randomUUID(), action)
  assert.deepEqual(result, { session_id: 'phone-session', agent_user_id: agentId, chat_id: chatId })
  assert.equal(fx.identities, 1)
  assert.equal(fx.commands.length, 2)
  assert.notEqual(fx.commands[0].id, fx.commands[1].id)
  assert.deepEqual(fx.commands.map((command) => command.agentUserId), [agentId, agentId])
  const requests = Object.values(fx.store.state.requests)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].operationId, saved.operationId)
  assert.equal(requests[0].provisionId, saved.provisionId)
  const claims = fx.calls.filter(([name]) => name === 'claim_provision_slots')
  assert.deepEqual(claims.map(([, args]) => args.p_retry_provision_ids), [null, [saved.provisionId]])
  const retryIndex = fx.calls.findIndex(([name, args]) => name === 'claim_provision_slots' && args.p_retry_provision_ids)
  assert.deepEqual(fx.calls[retryIndex - 1], ['read_provision', 'failed'])
  await fx.provision(randomUUID(), action)
  assert.equal(fx.commands.length, 2)
})

test('phone provision reply-loss recovery does not retry an awaiting command or resurrect a removed identity', async () => {
  const fx = provisionCase({ commandResults: ['pending', 'done'] })
  const action = { clientRequestId: randomUUID(), harness: 'pi', prompt: 'recover an awaiting task' }
  await assert.rejects(fx.provision(randomUUID(), action), /尚未完成/)
  await fx.provision(randomUUID(), action)
  assert.equal(fx.commands.length, 1)
  assert.deepEqual(fx.calls.filter(([name]) => name === 'claim_provision_slots').map(([, args]) => args.p_retry_provision_ids), [null])

  const removed = provisionCase({ commandResults: ['error'] })
  await assert.rejects(removed.provision(randomUUID(), action), /agent_create_command_error/)
  removed.row.agent_user_id = null
  await assert.rejects(removed.provision(randomUUID(), action), /已被移除/)
  assert.equal(removed.calls.filter(([name]) => name === 'claim_provision_slots').length, 1)
  assert.equal(removed.identities, 1)
})

test('phone provision marks only rejected validation before durable admission as safe to edit', async () => {
  for (const [options, extra] of [[{ modelError: true }, {}], [{ groupStatus: 'archived' }, { chatId: groupId }], [{}, { harness: 'claude' }]]) {
    const fx = provisionCase(options)
    await assert.rejects(fx.provision(randomUUID(), { clientRequestId: randomUUID(), harness: 'pi', prompt: 'task', ...extra }), { code: 'phone_create_rejected' })
    assert.deepEqual(fx.store.state.requests, {})
    assert.equal(fx.calls.some(([name]) => name === 'start_agent_provision_operation'), false)
  }
  for (const options of [{ saveError: true }, { startError: true }]) {
    const fx = provisionCase(options)
    await assert.rejects(fx.provision(randomUUID(), { clientRequestId: randomUUID(), harness: 'pi', prompt: 'task' }), (error) => error.code !== 'phone_create_rejected')
    assert.equal(Object.keys(fx.store.state.requests).length, 1)
  }
})

test('phone provision preserves the durable intent check for concurrent calls with the same id', async () => {
  const fx = provisionCase()
  const action = { clientRequestId: randomUUID(), harness: 'pi', prompt: 'original task' }
  const [first, second] = await Promise.allSettled([fx.provision(randomUUID(), action), fx.provision(randomUUID(), { ...action, prompt: 'different task' })])
  assert.equal(first.status, 'fulfilled')
  assert.equal(second.status, 'rejected')
  assert.match(second.reason.message, /不能更换/)
  assert.notEqual(second.reason.code, 'phone_create_rejected')
  assert.equal(fx.identities, 1)
  assert.equal(fx.commands.length, 1)
})

test('cancelling during model issuance prevents Pi from starting after the delayed ticket arrives', async () => {
  let turns = 0
  let entered = false
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const fx = await fixture(async () => { turns++; return { status: 'done', text: '[NO_REPLY]' } })
  const original = fx.cloud.modelAccess
  fx.cloud.modelAccess = async (body) => { if (body.action === 'issue') { entered = true; await gate } return original(body) }
  try {
    const created = await fx.host.invoke('sessionTimeline.sessionCreate', [{ harness: 'pi', prompt: '任务' }], randomUUID())
    await until(() => entered, fx.events)
    await fx.host.handle({ type: 'cancel', ownerId, sessionId: created.conversationId })
    release()
    await until(() => fx.events.some((event) => event.type === 'turn_failed' && event.status === 'cancelled'), fx.events)
    assert.equal(turns, 0)
    await until(() => fx.calls.some(([name, body]) => name === 'model-access' && body.action === 'revoke'), fx.events)
  } finally { release(); await fx.close() }
})

test('a failed turn retains data proof; explicit later revocation changes only the Pi context epoch', async () => {
  let revoked = false
  const epochs = []
  const fx = await fixture(async (command, hooks) => {
    epochs.push(command.contextEpoch)
    if (epochs.length === 1) {
      await hooks.extraTools.find((tool) => tool.name === 'fixture_read').execute()
      return { status: 'failed', text: '', error: 'simulated failure after reading' }
    }
    return { status: 'done', text: '[NO_REPLY]' }
  }, {
    nativeCall: async (name) => name === 'permissions.check' && revoked ? { ok: false, code: 'os_permission', message: 'selected photo no longer allowed' } : { ok: true },
    actionFactory: async () => ({ confirmationForMessage: () => null, cancel: async () => undefined, tools: ({ job }) => [{ name: 'fixture_read', execute: async () => { job.usedGroups = ['photos']; job.permissionRequirements = [{ mediaRefs: [{ kind: 'image', id: '1', version: 'v1' }] }]; return {} } }] }),
  })
  try {
    const created = await fx.host.invoke('sessionTimeline.sessionCreate', [{ harness: 'pi', prompt: 'read' }], randomUUID())
    await until(() => fx.events.some((event) => event.type === 'turn_failed'), fx.events)
    await until(() => fx.host.state().sessions[0].lastJobStatus === 'failed', fx.events)
    revoked = true
    const caller = { deviceId: 'cloud-fixture', sessionId: randomUUID(), name: 'source', harness: 'pi', transport: 'acp' }
    await fx.host.invoke('agentSession.message', [caller, { action: 'message', session_ids: [created.conversationId], text: 'continue' }], randomUUID())
    await until(() => epochs.length === 2, fx.events)
    assert.notEqual(epochs[0], epochs[1])
    assert.equal(fx.host.state().sessions[0].sessionId, created.conversationId)
    const journal = JSON.parse(await readFile(join(fx.root, 'hosts', ownerId, 'host.json'), 'utf8'))
    assert.deepEqual(journal.agents[agentId].dataProof, { groups: [], permissionRequirements: [] })
  } finally { await fx.close() }
})

const delegatedCalendarProof = { permissions: ['android.permission.READ_CALENDAR'], mediaRefs: [] }
async function seedPhoneAgents({ root, users }, ids, withoutContextEpoch = []) {
  const agents = Object.fromEntries(ids.map((id) => {
    if (!users.some((user) => user.id === id)) users.push({ id, type: 'agent', owner_user_id: ownerId, device_id: deviceId, display_name: '同机任务', desired_status: 'online' })
    return [id, { agentUserId: id, ownerId, deviceId, sessionId: randomUUID(), ...(withoutContextEpoch.includes(id) ? {} : { contextEpoch: randomUUID() }), displayName: '同机任务', chatId, modelId: 'free', status: 'idle', createdAt: new Date().toISOString() }]
  }))
  const directory = join(root, 'hosts', ownerId)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'host.json'), JSON.stringify({ version: 1, ownerId, agents, jobs: {}, outbox: {}, requests: {}, leases: {} }))
  return agents
}
const delegatedCalendarActions = async () => ({ confirmationForMessage: () => null, cancel: async () => undefined, tools: ({ job }) => [{ name: 'fixture_read', execute: async () => { job.usedGroups = ['calendar']; job.permissionRequirements = [structuredClone(delegatedCalendarProof)]; return {} } }] })

test('same-phone delegated input and queued timeline retain host proofs and fail before Pi after revocation', async () => {
  const recipientId = randomUUID()
  let agents, delegated = false, recipientTurns = 0, release
  const gate = new Promise((resolve) => { release = resolve })
  const fx = await fixture(async (command, hooks) => {
    if (command.agentUserId !== agentId) { recipientTurns += 1; return { status: 'done', text: '[NO_REPLY]' } }
    await hooks.extraTools.find((tool) => tool.name === 'fixture_read').execute()
    const send = hooks.extraTools.find((tool) => tool.name === 'session_message')
    await assert.rejects(send.execute('cannot-clear-source-proof', { to: [`session:${agents[recipientId].sessionId}`], text: '受保护的日历原文', usedGroups: [] }))
    await send.execute('delegate-calendar', { to: [`session:${agents[recipientId].sessionId}`], text: '受保护的日历原文' })
    delegated = true
    await gate
    return { status: 'done', text: '[NO_REPLY]' }
  }, { prepare: async (input) => { agents = await seedPhoneAgents(input, [agentId, recipientId]) }, actionFactory: delegatedCalendarActions })
  try {
    await fx.host.invoke('sessionTimeline.sessionSend', [{ conversationId: agents[agentId].sessionId, text: '查日历并委派' }], randomUUID())
    await until(() => delegated, fx.events)
    const readJournal = async () => JSON.parse(await readFile(join(fx.root, 'hosts', ownerId, 'host.json'), 'utf8'))
    const queued = Object.values((await readJournal()).jobs).find((job) => job.agentUserId === recipientId)
    assert.deepEqual(queued.inputDataProof, { groups: ['calendar'], permissionRequirements: [delegatedCalendarProof] })
    assert.equal(queued.status, 'queued')
    assert.match(JSON.stringify(await fx.host.invoke('sessionTimeline.sessionSnapshot', [{ conversationId: agents[recipientId].sessionId }])), /受保护的日历原文/)
    fx.config.grants.calendar = false
    const hidden = await fx.host.invoke('sessionTimeline.sessionSnapshot', [{ conversationId: agents[recipientId].sessionId }])
    assert.match(JSON.stringify(hidden), /旧记录已隐藏/)
    assert.doesNotMatch(JSON.stringify(hidden), /受保护的日历原文/)
    release()
    await until(() => fx.events.some((event) => event.type === 'host_state' && event.sessions.find((agent) => agent.agentUserId === recipientId)?.lastJobStatus === 'failed'), fx.events)
    assert.equal(recipientTurns, 0)
    const failed = (await readJournal()).jobs[queued.id]
    assert.equal(failed.errorCode, 'revoked')
    assert.match(failed.error, /未执行这条输入/)
    assert.deepEqual(failed.inputDataProof, queued.inputDataProof)
  } finally { release(); await fx.close() }
})

test('completed same-phone delegation carries proof into recipient context and notes, then rotates context on revocation', async () => {
  const recipientId = randomUUID()
  let agents, recipientTurns = 0
  const recipientEpochs = []
  const fx = await fixture(async (command, hooks) => {
    if (command.agentUserId === agentId) {
      await hooks.extraTools.find((tool) => tool.name === 'fixture_read').execute()
      await hooks.extraTools.find((tool) => tool.name === 'session_message').execute('delegate', { to: [`session:${agents[recipientId].sessionId}`], text: '只属日历的委派秘密' })
    } else {
      recipientTurns += 1; recipientEpochs.push(command.contextEpoch)
      if (recipientTurns === 1) await hooks.extraTools.find((tool) => tool.name === 'phone_memory_save').execute('remember', { key: '委派日历', text: '只属日历的委派秘密' })
      else {
        const found = await hooks.extraTools.find((tool) => tool.name === 'phone_memory_search').execute('search', { query: '委派' })
        assert.deepEqual(found.details.notes, [])
      }
    }
    await recordTurn(command, hooks, '[NO_REPLY]')
    return { status: 'done', text: '[NO_REPLY]' }
  }, { prepare: async (input) => { agents = await seedPhoneAgents(input, [agentId, recipientId]) }, actionFactory: delegatedCalendarActions })
  try {
    await fx.host.invoke('sessionTimeline.sessionSend', [{ conversationId: agents[agentId].sessionId, text: '查日历并委派' }], randomUUID())
    await until(() => fx.events.some((event) => event.type === 'host_state' && event.sessions.find((agent) => agent.agentUserId === recipientId)?.lastJobStatus === 'done'), fx.events)
    const journal = JSON.parse(await readFile(join(fx.root, 'hosts', ownerId, 'host.json'), 'utf8'))
    assert.deepEqual(journal.agents[recipientId].dataProof, { groups: ['calendar'], permissionRequirements: [delegatedCalendarProof] })
    const note = Object.values(journal.memory).find((item) => item.agentUserId === recipientId)
    assert.deepEqual(note.groups, ['calendar'])
    assert.deepEqual(note.permissionRequirements, [delegatedCalendarProof])
    fx.config.grants.calendar = false
    const hidden = await fx.host.invoke('sessionTimeline.sessionSnapshot', [{ conversationId: agents[recipientId].sessionId }])
    assert.match(JSON.stringify(hidden), /旧记录已隐藏/)
    assert.doesNotMatch(JSON.stringify(hidden), /只属日历的委派秘密/)
    const directory = await fx.host.invoke('sessionTimeline.sessionsList', [])
    assert.equal(directory.sessions.find((session) => session.conversationId === agents[recipientId].sessionId).supported, true)
    const beforeSecond = fx.events.length
    await fx.host.invoke('sessionTimeline.sessionSend', [{ conversationId: agents[recipientId].sessionId, text: '开始新的普通任务' }], randomUUID())
    await until(() => recipientTurns === 2 && fx.events.slice(beforeSecond).some((event) => event.type === 'host_state' && event.sessions.find((agent) => agent.agentUserId === recipientId)?.lastJobStatus === 'done'), fx.events)
    assert.notEqual(recipientEpochs[0], recipientEpochs[1])
    const snapshot = await fx.host.invoke('sessionTimeline.sessionSnapshot', [{ conversationId: agents[recipientId].sessionId }])
    assert.doesNotMatch(JSON.stringify(snapshot), /只属日历的委派秘密/)
  } finally { await fx.close() }
})

test('a cancelled first delegated input has a durable epoch and does not block a clean new turn after revocation', async () => {
  const recipientId = randomUUID()
  let agents, delegated = false, recipientTurns = 0, release
  const gate = new Promise((resolve) => { release = resolve })
  const fx = await fixture(async (command, hooks) => {
    if (command.agentUserId === agentId) {
      await hooks.extraTools.find((tool) => tool.name === 'fixture_read').execute()
      await hooks.extraTools.find((tool) => tool.name === 'session_message').execute('delegate-first', { to: [`session:${agents[recipientId].sessionId}`], text: '取消前排队的日历秘密' })
      delegated = true
      await gate
    } else {
      recipientTurns += 1
      assert.equal(command.prompt, '撤权后开始普通新任务')
      await recordTurn(command, hooks, '新的普通回答')
      return { status: 'done', text: '新的普通回答' }
    }
    return { status: 'done', text: '[NO_REPLY]' }
  }, { prepare: async (input) => { agents = await seedPhoneAgents(input, [agentId, recipientId], [recipientId]) }, actionFactory: delegatedCalendarActions })
  try {
    await fx.host.invoke('sessionTimeline.sessionSend', [{ conversationId: agents[agentId].sessionId, text: '查日历并委派' }], randomUUID())
    await until(() => delegated, fx.events)
    const readJournal = async () => JSON.parse(await readFile(join(fx.root, 'hosts', ownerId, 'host.json'), 'utf8'))
    const admitted = await readJournal()
    const queued = Object.values(admitted.jobs).find((job) => job.agentUserId === recipientId)
    assert.match(queued.contextEpoch, /^[0-9a-f-]{36}$/)
    assert.equal(admitted.agents[recipientId].contextEpoch, queued.contextEpoch)
    assert.deepEqual(admitted.agents[recipientId].dataProof, queued.inputDataProof)
    await fx.host.invoke('sessionTimeline.sessionCancel', [{ conversationId: agents[recipientId].sessionId }], randomUUID())
    assert.equal((await readJournal()).jobs[queued.id].status, 'cancelled')
    fx.config.grants.calendar = false
    const hidden = await fx.host.invoke('sessionTimeline.sessionSnapshot', [{ conversationId: agents[recipientId].sessionId }])
    assert.match(JSON.stringify(hidden), /旧记录已隐藏/)
    assert.doesNotMatch(JSON.stringify(hidden), /取消前排队的日历秘密/)
    await fx.host.invoke('sessionTimeline.sessionSend', [{ conversationId: agents[recipientId].sessionId, text: '撤权后开始普通新任务' }], randomUUID())
    release()
    await until(() => fx.events.some((event) => event.type === 'host_state' && event.sessions.find((agent) => agent.agentUserId === recipientId)?.lastJobStatus === 'done'), fx.events)
    assert.equal(recipientTurns, 1)
    const completed = await readJournal()
    assert.notEqual(completed.agents[recipientId].contextEpoch, queued.contextEpoch)
    assert.deepEqual(completed.agents[recipientId].dataProof, { groups: [], permissionRequirements: [] })
    assert.equal(completed.jobs[queued.id].contextEpoch, queued.contextEpoch)
    assert.equal(completed.jobs[queued.id].status, 'cancelled')
    const snapshot = await fx.host.invoke('sessionTimeline.sessionSnapshot', [{ conversationId: agents[recipientId].sessionId }])
    assert.match(JSON.stringify(snapshot), /新的普通回答/)
    assert.doesNotMatch(JSON.stringify(snapshot), /取消前排队的日历秘密/)
  } finally { release(); await fx.close() }
})

test('same-phone session_spawn persists its trusted input proof and never executes a revoked child prompt', async () => {
  const sourceId = randomUUID()
  let agents, child, release, childTurns = 0
  const gate = new Promise((resolve) => { release = resolve })
  const fx = await fixture(async (command, hooks) => {
    if (command.agentUserId !== sourceId) { childTurns += 1; return { status: 'done', text: '[NO_REPLY]' } }
    await hooks.extraTools.find((tool) => tool.name === 'fixture_read').execute()
    child = await hooks.extraTools.find((tool) => tool.name === 'session_spawn').execute('spawn-with-calendar', { harness: 'pi', prompt: '创建子任务中的日历秘密' })
    await gate
    return { status: 'done', text: '[NO_REPLY]' }
  }, { prepare: async (input) => { agents = await seedPhoneAgents(input, [sourceId]) }, actionFactory: delegatedCalendarActions })
  try {
    await fx.host.invoke('sessionTimeline.sessionSend', [{ conversationId: agents[sourceId].sessionId, text: '查日历并创建子任务' }], randomUUID())
    await until(() => child, fx.events)
    const journal = JSON.parse(await readFile(join(fx.root, 'hosts', ownerId, 'host.json'), 'utf8'))
    const proof = { groups: ['calendar'], permissionRequirements: [delegatedCalendarProof] }
    assert.deepEqual(Object.values(journal.requests).find((request) => request.kind === 'spawn').inputDataProof, proof)
    assert.deepEqual(Object.values(journal.jobs).find((job) => job.agentUserId === agentId).inputDataProof, proof)
    fx.config.grants.calendar = false
    const target = fx.host.state().sessions.find((agent) => agent.agentUserId === agentId)
    const hidden = await fx.host.invoke('sessionTimeline.sessionSnapshot', [{ conversationId: target.sessionId }])
    assert.match(JSON.stringify(hidden), /旧记录已隐藏/)
    assert.doesNotMatch(JSON.stringify(hidden), /创建子任务中的日历秘密/)
    release()
    await until(() => fx.events.some((event) => event.type === 'host_state' && event.sessions.find((agent) => agent.agentUserId === agentId)?.lastJobStatus === 'failed'), fx.events)
    assert.equal(childTurns, 0)
  } finally { release(); await fx.close() }
})

test('RPC connectivity cannot publish ready before the initial heartbeat and startup recovery finish', async () => {
  const fx = await fixture(async () => ({ status: 'done', text: '[NO_REPLY]' }), {
    prepare: async ({ cloud, events }) => {
      const original = cloud.identity.rpc
      cloud.identity.rpc = async (name, args) => {
        if (name === 'recover_orphaned_device_commands') assert.equal(events.some((event) => event.type === 'host_state' && event.ready), false)
        return original(name, args)
      }
    },
    onRpcStart: ({ onConnectivity, events, calls }) => {
      onConnectivity(true)
      assert.equal(events.some((event) => event.type === 'host_state' && event.ready), false)
      assert.equal(calls.some(([name]) => name === 'runtime_instance_heartbeat'), true)
      assert.equal(calls.filter(([name]) => name === 'upsert_device').at(-1)[1].capabilities.host_runtime_capability, 0)
    },
  })
  try { assert.equal(fx.host.state().ready, true) } finally { await fx.close() }
})

test('queued tasks resume after RPC and auth recover without another message or admission', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const prompts = []
  const fx = await fixture(async (command, hooks) => {
    prompts.push(command.prompt)
    if (prompts.length === 1) await gate
    await recordTurn(command, hooks, '真实结果')
    return { status: 'done', text: '真实结果' }
  })
  try {
    const created = await fx.host.invoke('sessionTimeline.sessionCreate', [{ harness: 'pi', prompt: '第一件任务' }], randomUUID())
    await until(() => prompts.length === 1, fx.events)
    await fx.host.invoke('sessionTimeline.sessionSend', [{ conversationId: created.conversationId, text: '已接收的第二件任务', clientRequestId: randomUUID() }], randomUUID())
    fx.connectivityChanged(false)
    release()
    await until(() => fx.host.state().execution === null, fx.events)
    assert.equal(fx.host.state().sessions[0].lastJobStatus, 'queued')
    await fx.authChanged(null, Object.assign(new Error('续期暂时失败'), { code: 'network_error' }))
    fx.connectivityChanged(true)
    assert.equal(fx.host.state().ready, false)
    await fx.host.handle({ type: 'configure', config: fx.config })
    assert.equal(fx.host.state().ready, false)
    await fx.authChanged({ access_token: 'renewed', refresh_token: 'renewed', expires_at: 9999999999 })
    await until(() => fx.host.state().sessions[0].lastJobStatus === 'done' && fx.host.state().execution === null, fx.events)
    assert.deepEqual(prompts, ['第一件任务', '已接收的第二件任务'])
  } finally { release(); await fx.close() }
})

test('a failed heartbeat changes admission state and other healthy signals cannot override it', async () => {
  const fx = await fixture(async () => ({ status: 'done', text: '[NO_REPLY]' }))
  const original = fx.cloud.identity.from
  let fail = true
  fx.cloud.identity.from = (table) => {
    const query = original(table)
    if (table === 'gugu_devices') {
      const upsert = query.upsert
      query.upsert = (row, options) => fail ? Promise.resolve({ error: { message: 'heartbeat unreachable' } }) : upsert(row, options)
    }
    return query
  }
  try {
    await assert.rejects(fx.host.handle({ type: 'configure', config: fx.config }), /heartbeat unreachable/)
    assert.equal(fx.host.state().ready, false)
    assert.equal(fx.host.state().status, 'failed')
    fx.connectivityChanged(true)
    await fx.authChanged({ access_token: 'valid', refresh_token: 'valid', expires_at: 9999999999 })
    assert.equal(fx.host.state().ready, false)
    assert.match(fx.host.state().error, /heartbeat unreachable/)
    await assert.rejects(fx.host.invoke('sessionTimeline.sessionsList', []), /尚未就绪/)
    fail = false
    await fx.host.handle({ type: 'configure', config: fx.config })
    assert.equal(fx.host.state().ready, true)
    assert.equal(fx.host.state().error, null)
  } finally { await fx.close() }
})

test('closing the task host withdraws only runtime capability on its owner-scoped device row', async () => {
  const fx = await fixture(async () => ({ status: 'done', text: '[NO_REPLY]' }))
  try {
    const device = fx.devices.find((row) => row.device_id === deviceId)
    device.capabilities.actions = { v: 1, actions: [{ name: 'calendar.events.list', available: true }] }
    device.capabilities.futureCapability = 'preserve'
    const before = structuredClone(device)
    await fx.host.close()
    assert.equal(device.status, before.status)
    assert.equal(device.last_seen_at, before.last_seen_at)
    assert.deepEqual(device.capabilities.actions, before.capabilities.actions)
    assert.equal(device.capabilities.futureCapability, 'preserve')
    assert.equal(device.capabilities.host_runtime_capability, 0)
    assert.deepEqual(device.capabilities.runtimes, [])
    assert.deepEqual(fx.calls.find(([name]) => name === 'update_device')[1].filters, [['device_id', deviceId], ['user_id', ownerId]])
  } finally { await fx.close() }
})

for (const mode of ['cancel', 'stop', 'timeout']) test(`${mode} during a confirmed write retains its unknown outcome`, async () => {
  const cancelled = mode === 'cancel'
  let turns = 0
  let writing = false
  let writes = 0
  const fx = await fixture(async (command, hooks) => {
    if (++turns === 1) await hooks.extraTools.find((tool) => tool.name === 'phone_call').execute('confirm-write', { name: 'calendar.events.create', args: { title: 'private-old-calendar-title-7521', start: '2026-10-21T14:00:00+08:00', end: '2026-10-21T14:30:00+08:00' } })
    else {
      assert.match(hooks.systemPrompt, /宿主持久记录显示/)
      assert.match(hooks.systemPrompt, /No result provided 不代表操作未执行/)
      assert.doesNotMatch(hooks.systemPrompt, /private-old-calendar-title-7521/)
    }
    await recordTurn(command, hooks, '请检查任务记录')
    return { status: 'done', text: '请检查任务记录' }
  }, { actionFactory: createPhoneActionRuntime, nativeCall: async (name, _args, signal) => {
    if (name === 'permissions.check' || name === 'permissions.preflight') return { ok: true }
    writes++; writing = true
    if (mode === 'timeout') return { ok: false, code: 'timeout', message: '手机原生动作在 180 秒内未返回' }
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  try {
    const created = await fx.host.invoke('sessionTimeline.sessionCreate', [{ harness: 'pi', prompt: '创建一个日程' }], randomUUID())
    await until(() => fx.host.state().sessions[0]?.status === 'needs_user', fx.events)
    const snapshot = await fx.host.invoke('sessionTimeline.sessionSnapshot', [{ conversationId: created.conversationId }])
    await fx.host.handle({ type: 'host_call', ownerId, source: 'native-ui', id: randomUUID(), channel: 'sessionTimeline.sessionRespond', args: [{ conversationId: created.conversationId, itemId: snapshot.settlements[0].itemId, kind: 'permission', optionId: 'approve' }] })
    await until(() => writing, fx.events)
    if (cancelled) await fx.host.handle({ type: 'cancel', ownerId, sessionId: created.conversationId })
    else if (mode === 'stop') await fx.host.close()
    await until(() => fx.events.some((event) => event.type === 'turn_failed' && event.code === 'execution_unknown'), fx.events)
    const failure = fx.events.find((event) => event.type === 'turn_failed' && event.code === 'execution_unknown')
    assert.equal(failure.status, cancelled ? 'cancelled' : 'interrupted')
    assert.match(failure.error, /结果尚未确认.*不能自动重复执行/)
    assert.equal(turns, 1)
    assert.match(fx.host.state().sessions[0].lastError, /结果尚未确认/)
    if (mode !== 'stop') {
      await fx.host.invoke('sessionTimeline.sessionSend', [{ conversationId: created.conversationId, text: '先核对实际结果', clientRequestId: randomUUID() }], randomUUID())
      await until(() => turns === 2 && fx.host.state().sessions[0].lastJobStatus === 'done', fx.events)
    }
    assert.equal(writes, 1)
  } finally { await fx.close() }
})

test('a cold host preserves running jobs and executing confirmations as interrupted and warns the next real turn', async () => {
  const sessionId = randomUUID()
  const contextEpoch = randomUUID()
  const oldJobId = randomUUID()
  const pendingId = randomUUID()
  let turns = 0
  const fx = await fixture(async (command, hooks) => {
    turns++
    assert.equal(command.prompt, '先核对实际结果')
    assert.match(hooks.systemPrompt, /宿主持久记录显示.*结果尚未确认/)
    assert.doesNotMatch(hooks.systemPrompt, /private-interrupted-input|private-interrupted-args/)
    await recordTurn(command, hooks, '已提示核对')
    return { status: 'done', text: '已提示核对' }
  }, { actionFactory: createPhoneActionRuntime, prepare: async ({ root }) => {
    const directory = join(root, 'hosts', ownerId)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'host.json'), JSON.stringify({ version: 1, ownerId, agents: { [agentId]: { agentUserId: agentId, ownerId, deviceId, sessionId, contextEpoch, displayName: '手机 Agent', chatId, modelId: 'free', status: 'working' } }, jobs: { [oldJobId]: { id: oldJobId, agentUserId: agentId, prompt: 'private-interrupted-input', status: 'running', createdAt: new Date(0).toISOString() } }, confirmations: { [pendingId]: { id: pendingId, ownerId, agentUserId: agentId, sessionId, contextEpoch, status: 'executing', actionName: 'calendar.events.create', question: '是否创建日程', createdAt: new Date(0).toISOString(), expiresAt: new Date(9999999999999).toISOString(), args: { title: 'private-interrupted-args' } } }, outbox: {}, requests: {}, leases: {} }))
  } })
  try {
    const journal = JSON.parse(await readFile(join(fx.root, 'hosts', ownerId, 'host.json'), 'utf8'))
    assert.equal(journal.jobs[oldJobId].status, 'interrupted')
    assert.equal(journal.confirmations[pendingId].status, 'interrupted')
    assert.equal(turns, 0)
    await fx.host.invoke('sessionTimeline.sessionSend', [{ conversationId: sessionId, text: '先核对实际结果', clientRequestId: randomUUID() }], randomUUID())
    await until(() => turns === 1 && fx.host.state().sessions[0].lastJobStatus === 'done', fx.events)
  } finally { await fx.close() }
})

test('native Skill settings reach Pi progressively, reject remote/busy writes and preserve task history', async () => {
  const skillId = randomUUID()
  const configured = { id: skillId, name: '核对日程', description: '使用真实手机工具', instructions: '# 主人配置\nprivate-skill-body-marker\n不能绕过系统权限。', enabled: true }
  const source = { kind: 'native-ui', ownerId }
  const commands = []
  let fx
  fx = await fixture(async (command, hooks) => {
    commands.push(command)
    const list = hooks.extraTools.find((tool) => tool.name === 'phone_skills_list')
    const read = hooks.extraTools.find((tool) => tool.name === 'phone_skills_read')
    const listing = await list.execute('discover-skills', {})
    assert.match(hooks.systemPrompt, /调用 phone_memory_search/)
    assert.match(hooks.systemPrompt, /才用 phone_memory_save/)
    assert.doesNotMatch(hooks.systemPrompt, /private-skill-body-marker/)
    assert.doesNotMatch(JSON.stringify(listing), /private-skill-body-marker/)
    if (commands.length === 2) {
      assert.equal(listing.details.skills[0].id, skillId)
      assert.equal((await read.execute('read-skill', { id: skillId })).details.skill.instructions, configured.instructions)
      await assert.rejects(fx.host.invoke('sessionTimeline.phoneSkillsSet', [{ conversationId: command.sessionId, expectedRevision: 1, skills: [configured] }], randomUUID(), source), { code: 'session_busy' })
    } else assert.deepEqual(listing.details.skills, [])
    await recordTurn(command, hooks, '已按现有工具和授权完成')
    return { status: 'done', text: '已按现有工具和授权完成' }
  })
  try {
    const created = await fx.host.invoke('sessionTimeline.sessionCreate', [{ harness: 'pi', prompt: '建立手机任务' }], randomUUID())
    const settings = () => fx.host.invoke('sessionTimeline.phoneSkillsGet', [{ conversationId: created.conversationId }], randomUUID(), source)
    const history = async () => (await fx.host.invoke('sessionTimeline.sessionSnapshot', [{ conversationId: created.conversationId }])).turns
    await until(async () => commands.length === 1 && (await settings()).editable, fx.events)
    const beforeSave = await history()
    await assert.rejects(fx.host.invoke('sessionTimeline.phoneSkillsSet', [{ conversationId: created.conversationId, expectedRevision: 0, skills: [configured] }], randomUUID()), { code: 'not_granted' })
    const saveId = randomUUID()
    await fx.host.handle({ type: 'host_call', ownerId, source: 'native-ui', id: saveId, channel: 'sessionTimeline.phoneSkillsSet', args: [{ conversationId: created.conversationId, expectedRevision: 0, skills: [configured] }] })
    assert.equal(fx.events.find((event) => event.type === 'host_result' && event.id === saveId).result.revision, 1)
    assert.deepEqual(await history(), beforeSave)
    await fx.host.invoke('sessionTimeline.sessionSend', [{ conversationId: created.conversationId, text: '按启用说明执行', clientRequestId: randomUUID() }], randomUUID())
    await until(async () => commands.length === 2 && (await settings()).editable, fx.events)
    assert.equal(commands[1].contextEpoch, commands[0].contextEpoch)
    const same = await fx.host.invoke('sessionTimeline.phoneSkillsSet', [{ conversationId: created.conversationId, expectedRevision: 1, skills: [configured] }], randomUUID(), source)
    assert.equal(same.revision, 1)
    const beforeDisable = await history()
    await fx.host.invoke('sessionTimeline.phoneSkillsSet', [{ conversationId: created.conversationId, expectedRevision: 1, skills: [{ ...configured, enabled: false }] }], randomUUID(), source)
    assert.deepEqual(await history(), beforeDisable)
    await fx.host.invoke('sessionTimeline.sessionSend', [{ conversationId: created.conversationId, text: '不使用已禁用说明', clientRequestId: randomUUID() }], randomUUID())
    await until(async () => commands.length === 3 && (await settings()).editable, fx.events)
    assert.equal(commands[2].contextEpoch, commands[1].contextEpoch)
    assert.equal((await history()).length, 3)
    const journal = JSON.parse(await readFile(join(fx.root, 'hosts', ownerId, 'host.json'), 'utf8'))
    assert.deepEqual(Object.values(journal.jobs).map((job) => job.skillRevision), [0, 1, 2])
    assert.equal(journal.agents[agentId].skills.items[0].enabled, false)
  } finally { await fx.close() }
})

test('parent EOF during a requested host stop waits for the same persistence and cloud cleanup', async () => {
  let releaseCleanup
  const cleanup = new Promise((resolve) => { releaseCleanup = resolve })
  let cleanupStarted = false, cloudCloses = 0, parentClosed = false
  const fx = await fixture(async () => ({ status: 'done', text: '' }), { prepare: async ({ cloud }) => {
    cloud.close = async () => { cloudCloses++; cleanupStarted = true; await cleanup }
  } })
  const input = new EventEmitter(), output = new EventEmitter()
  const entry = createAgentEntry({ runTurn: async () => assert.fail('no new turn during shutdown'), cancelTurn: () => {},
    startPhoneAgentHost: async () => fx.host, bridge: { close: () => {} }, output: () => {} })
  const bound = bindAgentEntry(entry, { input, output, onError: (error) => assert.fail(error.message),
    onTimeout: () => assert.fail('cleanup should complete before the shutdown deadline'), onClosed: () => { parentClosed = true } })
  try {
    input.emit('line', JSON.stringify({ type: 'host_start', ownerId }))
    await new Promise((resolve) => setImmediate(resolve))
    input.emit('line', JSON.stringify({ type: 'host_stop', ownerId }))
    await until(() => cleanupStarted, fx.events)
    input.emit('close')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(parentClosed, false, 'parent must not exit while the original cleanup is pending')
    assert.equal(cloudCloses, 1)
    releaseCleanup()
    await bound.close()
    assert.equal(parentClosed, true)
    assert.equal(cloudCloses, 1)
  } finally {
    releaseCleanup()
    await bound.close()
    await fx.close()
  }
})

test('account work prepare provisions a stable dormant phone seat without admitting or running the task', async () => {
  let turns=0
  const fx=await fixture(async()=>{turns++;return {status:'done',text:'[NO_REPLY]'}})
  const caller={sessionId:randomUUID(),deviceId:'coordinator-device',name:'Assistant',harness:'pi',platformModel:'platform:free',transport:'acp'}
  const intent={version:1,assistant_id:randomUUID(),work_id:randomUUID(),operation_id:randomUUID(),message_id:randomUUID(),child_session_id:randomUUID(),coordinator:{session_id:caller.sessionId,device_id:caller.deviceId},title:'Task',continuation:false}
  try {
    const action={action:'spawn',harness:'pi',prompt:'Only run after account enqueue',assistant_work:intent}
    const seat=await fx.host.invoke('assistantWork.prepare',[caller,action],'first-connection')
    assert.equal(seat.session_id,intent.child_session_id)
    assert.deepEqual(seat.assistant_work_target,{session_id:intent.child_session_id,device_id:deviceId})
    assert.equal((await fx.host.invoke('assistantWork.prepare',[caller,action],'second-connection')).session_id,seat.session_id)
    assert.equal(fx.commands.length,1)
    assert.equal(turns,0)
    const journal=JSON.parse(await readFile(join(fx.root,'hosts',ownerId,'host.json'),'utf8'))
    assert.deepEqual(Object.values(journal.jobs),[])
  } finally {await fx.close()}
})

test('account work delivery rereads cloud text and reuses its stable id on the phone',async()=>{
  let turns=0
  const fx=await fixture(async()=>{turns++;return {status:'done',text:'[NO_REPLY]'}})
  try {
    const created=await fx.host.invoke('sessionTimeline.sessionCreate',[{harness:'pi',prompt:'first',clientRequestId:randomUUID()}],'create')
    await until(()=>turns===1,fx.events)
    const ref={assistant_id:randomUUID(),work_id:randomUUID(),message_id:randomUUID()}
    const old=fx.cloud.identity.rpc
    fx.cloud.identity.rpc=async(name,args)=> name==='assistant_work_history' ? {data:{events:[{...ref,kind:'dispatch',from_session_id:randomUUID(),from_device_id:'coordinator',to_session_id:created.conversationId,to_device_id:deviceId,source_available:true,content:'Fresh cloud task',attachment_refs:[],platform_received_at:'2026-10-26T08:00:00Z'}],next_after:null},error:null} : old(name,args)
    const received=await fx.host.invoke('assistantWork.deliver',[{...ref,content:'Untrusted wire text'}],'wire-one')
    assert.equal(received.status,'admitted')
    assert.equal(received.messageId,ref.message_id)
    await fx.host.invoke('assistantWork.deliver',[ref],'wire-two')
    await until(()=>turns===2,fx.events)
    const journal=JSON.parse(await readFile(join(fx.root,'hosts',ownerId,'host.json'),'utf8'))
    assert.match(journal.jobs[ref.message_id].prompt,/Fresh cloud task/)
    assert.doesNotMatch(journal.jobs[ref.message_id].prompt,/Untrusted wire/)
    assert.match(journal.jobs[ref.message_id].prompt,/2026-10-26/)
    assert.equal(turns,2)
  }finally{await fx.close()}
})

test('cancelling a cold phone work delivery during cloud read never admits its first input',async()=>{
  let turns=0,release,reading
  const gate=new Promise(resolve=>{release=resolve})
  const entered=new Promise(resolve=>{reading=resolve})
  const fx=await fixture(async()=>{turns++;return {status:'done',text:'[NO_REPLY]'}})
  const caller={sessionId:randomUUID(),deviceId:'home',name:'Assistant',harness:'pi',platformModel:'platform:free',transport:'acp'}
  const intent={version:1,assistant_id:randomUUID(),work_id:randomUUID(),operation_id:randomUUID(),message_id:randomUUID(),child_session_id:randomUUID(),coordinator:{session_id:caller.sessionId,device_id:caller.deviceId},title:'Task',continuation:false}
  try {
    await fx.host.invoke('assistantWork.prepare',[caller,{action:'spawn',harness:'pi',prompt:'Wait for delivery',assistant_work:intent}],'prepare-cancel')
    const old=fx.cloud.identity.rpc
    fx.cloud.identity.rpc=async(name,args)=>{
      if(name!=='assistant_work_history') return old(name,args)
      reading();await gate
      return {data:{events:[{work_id:intent.work_id,message_id:intent.message_id,kind:'dispatch',from_session_id:caller.sessionId,from_device_id:caller.deviceId,to_session_id:intent.child_session_id,to_device_id:deviceId,source_available:true,content:'Must not run',attachment_refs:[],platform_received_at:new Date().toISOString()}],next_after:null},error:null}
    }
    const controller=new AbortController()
    const delivery=fx.host.invoke('assistantWork.deliver',[{assistant_id:intent.assistant_id,work_id:intent.work_id,message_id:intent.message_id}],'cancel-deliver',{kind:'device-rpc',signal:controller.signal})
    await entered;controller.abort(new Error('Delivery cancelled'));release()
    await assert.rejects(delivery,/Delivery cancelled/)
    const journal=JSON.parse(await readFile(join(fx.root,'hosts',ownerId,'host.json'),'utf8'))
    assert.equal(journal.jobs[intent.message_id],undefined)
    assert.equal(turns,0)
  } finally {release();await fx.close()}
})

test('a phone work result enters the account queue while its coordinator device is unavailable',async()=>{
  let reportResult
  const fx=await fixture(async(_command,hooks)=>{
    reportResult=await hooks.extraTools.find(tool=>tool.name==='session_message').execute('result-call',{to:[`session:${caller.sessionId}`],text:'Verified result',work_result:{work_id:intent.work_id,status:'completed'}})
    return {status:'done',text:'[NO_REPLY]'}
  })
  const caller={sessionId:randomUUID(),deviceId:'sleeping-home',agentUserId:randomUUID(),name:'Assistant',harness:'pi',platformModel:'platform:free',transport:'acp'}
  const intent={version:1,assistant_id:caller.agentUserId,work_id:randomUUID(),operation_id:randomUUID(),message_id:randomUUID(),child_session_id:randomUUID(),coordinator:{session_id:caller.sessionId,device_id:caller.deviceId},title:'Task',continuation:false}
  const old=fx.cloud.identity.rpc
  fx.cloud.identity.rpc=async(name,args)=>{
    fx.calls.push([name,args])
    if(name==='assistant_work_history')return {data:{work:{work_id:intent.work_id,assistant_user_id:intent.assistant_id,coordinator_session_id:caller.sessionId,coordinator_device_id:caller.deviceId,executors:[{session_id:intent.child_session_id,device_id:deviceId}]},events:[{work_id:intent.work_id,message_id:intent.message_id,kind:'dispatch',from_session_id:caller.sessionId,from_device_id:caller.deviceId,to_session_id:intent.child_session_id,to_device_id:deviceId,source_available:true,content:'Do the task',attachment_refs:[],platform_received_at:new Date().toISOString()}],next_after:null},error:null}
    if(name==='assistant_work_commit')return {data:{work_id:args.p_work_id,event_ids:args.p_events.map(e=>e.message_id),outcome:'completed',terminal_version:'1'},error:null}
    return old(name,args)
  }
  try{
    await fx.host.invoke('assistantWork.prepare',[caller,{action:'spawn',harness:'pi',prompt:'Do the task',assistant_work:intent}],'prepare')
    await fx.host.invoke('assistantWork.deliver',[{assistant_id:intent.assistant_id,work_id:intent.work_id,message_id:intent.message_id}],'deliver')
    await until(()=>Boolean(reportResult),fx.events)
    assert.equal(reportResult.details.status,'accepted')
    const queued=fx.calls.find(([name])=>name==='assistant_work_commit')[1]
    assert.equal(queued.p_events[0].kind,'completed')
    assert.equal(queued.p_events[0].to_device_id,'sleeping-home')
    assert.equal(fx.sessionReplies.length,0)
  }finally{await fx.close()}
})


test('startup imports acknowledged legacy work and queues host failure through the sole account outbox', async () => {
  const workId=randomUUID(),messageId=randomUUID(),sessionId=randomUUID(),assistantId=randomUUID(),coordinator=randomUUID()
  const caller={sessionId:coordinator,deviceId:'home',agentUserId:assistantId}
  const task={work_id:workId,assistant_user_id:assistantId,coordinator_session_id:coordinator,coordinator_device_id:'home',executors:[{session_id:sessionId,device_id:deviceId}]}
  let imported=false
  const fx=await fixture(async()=>{throw new Error('historical failed work must not rerun')},{prepare:async({root,cloud})=>{
    const rpc=cloud.identity.rpc
    cloud.identity.rpc=async(name,args)=>{
      if(name==='assistant_work_history') return imported ? {data:{work:task,events:[],next_after:null},error:null} : {data:null,error:{code:'42501',message:'Work is not available to this account'}}
      if(name==='assistant_work_import'){imported=true;return {data:{event_ids:args.p_events.map(row=>row.message_id)},error:null}}
      if(name==='assistant_work_commit'){cloud.workEvents??=[];cloud.workEvents.push(args.p_events[0]);return {data:{work_id:workId,event_ids:args.p_events.map(row=>row.message_id),outcome:'active',terminal_version:'0'},error:null}}
      return rpc(name,args)
    }
    const body=`Original task\n\n<gugu_work>\n${JSON.stringify({work_id:workId,coordinator:`session:${coordinator}`,report:'Report results'})}\n</gugu_work>`
    const directory=join(root,'hosts',ownerId);await mkdir(directory,{recursive:true})
    await writeFile(join(directory,'host.json'),JSON.stringify({version:1,ownerId,agents:{[agentId]:{agentUserId:agentId,sessionId,displayName:'Legacy task',status:'error',caller,modelId:'free'}},jobs:{[messageId]:{id:messageId,agentUserId:agentId,status:'failed',createdAt:'2026-10-20T08:00:00Z',finishedAt:'2026-10-20T08:01:00Z',error:'这次手机任务没能完成，网络连接反复中断。',sent:[],route:{kind:'session-direct',caller,sourceMessageId:messageId},prompt:buildSessionDirectEnvelope({senderSessionId:coordinator,senderTitle:'Assistant',messageId,content:body,at:'2026-10-20T08:00:00Z'})}},outbox:{},requests:{},leases:{}}))
  }})
  try{
    await until(()=>fx.cloud.workEvents?.length===1,fx.events)
    assert.equal(imported,true)
    assert.equal(fx.cloud.workEvents[0].kind,'progress')
    assert.equal(fx.cloud.workEvents[0].reason_code,'HOST_FAILURE')
    assert.equal(fx.cloud.workEvents[0].content,'这次手机任务没能完成，平台已单独发出失败说明，不用再转告。')
    assert.doesNotMatch(fx.cloud.workEvents[0].content,/网络连接|主人/)
    assert.equal(fx.sessionReplies.length,0)
    const journal=JSON.parse(await readFile(join(fx.root,'hosts',ownerId,'host.json'),'utf8'))
    assert.equal(journal.jobs[messageId].failureNotice,undefined)
    await fx.host.handle({type:'configure',config:fx.config})
    assert.equal(fx.cloud.workEvents.length,1)
  }finally{await fx.close()}
})

test('session get exposes native running and terminal proof for the exact latest admitted prompt',async()=>{
 let finish
 const gate=new Promise(resolve=>{finish=resolve})
 const fx=await fixture(async()=>{await gate;return {status:'done',text:'[NO_REPLY]'}})
 const caller={sessionId:randomUUID(),deviceId:'coordinator'}
 const messageId=randomUUID()
 try{
  const created=await fx.host.invoke('sessionTimeline.sessionCreate',[{harness:'pi',prompt:'Initial task',clientRequestId:randomUUID()}],'create-proof')
  await until(()=>Boolean(fx.host.state().execution),fx.events)
  const get=()=>fx.host.invoke('agentSession.get',[caller,{action:'get',session_id:created.conversationId}],'proof')
  const running=await get()
  assert.equal(running.preview.running,true)
  assert.equal(running.preview.ended,null)
  finish()
  await until(()=>fx.host.state().sessions.some(row=>row.sessionId===created.conversationId&&row.lastJobStatus==='done'),fx.events)
  await fx.host.invoke('agentSession.message',[caller,{action:'message',session_ids:[created.conversationId],text:'Next original prompt',client_message_id:messageId,client_message_at:'2026-10-26T08:00:00Z'}],'next-proof')
  await until(()=>fx.host.state().sessions.some(row=>row.sessionId===created.conversationId&&row.lastJobStatus==='done'),fx.events)
  const ended=await get()
  assert.equal(ended.preview.running,false)
  assert.equal(ended.preview.ended.kind,'done')
  assert.equal(ended.preview.entries.at(-1).messageId,messageId)
 }finally{finish();await fx.close()}
})

test('retire keeps phone history but the shared view excludes it from inbox and live inventory', async () => {
  let nudge
  const fx = await fixture(async (command, hooks) => {
    await recordTurn(command, hooks, 'kept history')
    return { status: 'done', text: 'kept history' }
  }, { onRpcStart: ({ onCommand }) => { nudge = onCommand } })
  try {
    const created = await fx.host.invoke('sessionTimeline.sessionCreate', [{ harness: 'pi', prompt: 'keep history' }], 'archive-contract')
    await until(() => fx.host.state().sessions[0]?.lastJobStatus === 'done', fx.events)
    fx.commands.push({ id: randomUUID(), type: 'agent.retire', status: 'pending', created_at: new Date().toISOString(), payload: { agent_user_id: agentId } })
    await nudge()
    const journal = JSON.parse(await readFile(join(fx.root, 'hosts', ownerId, 'host.json'), 'utf8'))
    assert.equal(journal.agents[agentId].status, 'archived')
    assert.equal(journal.agents[agentId].sessionId, created.conversationId)
    assert.equal(Object.values(journal.jobs)[0].text, 'kept history')
    assert.equal((await fx.host.invoke('sessionTimeline.sessionsList', [])).sessions.length, 0)
    const pulls = fx.calls.filter(([name]) => name === 'pull_agent_inbox_v2').length
    fx.commands.push({ id: randomUUID(), type: 'agent.deliver', status: 'pending', created_at: new Date().toISOString(), payload: { agent_user_id: agentId } })
    await nudge()
    assert.equal(fx.calls.filter(([name]) => name === 'pull_agent_inbox_v2').length, pulls)
    assert.deepEqual(fx.calls.filter(([name]) => name === 'archive_user'), [])
  } finally { await fx.close() }
})

test('the conversation queue reserves edits across entry points and resumes the same native input after saving', async () => {
  let releaseFirst
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  const prompts = []
  const fx = await fixture(async (command, hooks) => {
    prompts.push(command.prompt)
    if (prompts.length === 1) await firstGate
    await recordTurn(command, hooks, 'completed')
    return { status: 'done', text: 'completed' }
  })
  try {
    const created = await fx.host.invoke('sessionTimeline.sessionCreate', [{ harness: 'pi', prompt: 'first input' }], randomUUID())
    await until(() => prompts.length === 1, fx.events)
    await fx.host.invoke('sessionTimeline.sessionSend', [{ conversationId: created.conversationId, text: 'queued input', clientRequestId: randomUUID() }], randomUUID())
    const snapshot = () => fx.host.invoke('sessionTimeline.sessionSnapshot', [{ conversationId: created.conversationId }])
    const queued = (await snapshot()).queuedPrompts[0]
    const mutate = action => fx.host.invoke('sessionTimeline.sessionQueue', [{ conversationId: created.conversationId, action }], randomUUID())
    await mutate({ kind: 'edit', id: queued.id, text: queued.text, queueEdit: { draftText: 'editing from another entry', originalDraftText: 'normal draft' } })
    assert.equal((await snapshot()).queuedPrompts[0].queueEdit.draftText, 'editing from another entry')
    releaseFirst()
    await until(() => fx.host.state().execution === null, fx.events)
    assert.deepEqual(prompts, ['first input'])
    await mutate({ kind: 'edit', id: queued.id, text: 'edited native input', queueEdit: null })
    await until(() => prompts.length === 2 && fx.host.state().execution === null, fx.events)
    assert.deepEqual(prompts, ['first input', 'edited native input'])
    assert.deepEqual((await snapshot()).queuedPrompts, [])
  } finally { releaseFirst(); await fx.close() }
})

test('resolves files at run time, warns without blocking later text, and persists the public input projection beyond jobs', async () => {
  const prompts = [];
  const ref = { itemId: randomUUID(), version: 1, name: 'missing.txt', mimeType: 'text/plain', sizeBytes: 3 };
  const fx = await fixture(async (command, hooks) => {
    prompts.push(command.prompt);
    await recordTurn(command, hooks, '文件没能读取，请重新发送');
    return { status: 'done', text: '文件没能读取，请重新发送' };
  }, { prepare: ({ cloud }) => {
    cloud.attachmentEndpoint = async () => ({ supabaseUrl: 'https://files.invalid', anonKey: 'public', token: 'test', fetch: async () => new Response(JSON.stringify({ status: 'gone', sha256: null }), { status: 200, headers: { 'Content-Type': 'application/json' } }) });
  } });
  try {
    const created = await fx.host.invoke('sessionTimeline.sessionCreate', [{ harness: 'pi', prompt: 'initial plain input' }], randomUUID());
    await until(() => prompts.length === 1 && fx.host.state().sessions[0]?.lastJobStatus === 'done', fx.events);
    let journal = JSON.parse(await readFile(join(fx.root, 'hosts', ownerId, 'host.json'), 'utf8'));
    assert.equal(Object.values(journal.agents)[0].fileInputs, undefined);
    await fx.host.invoke('sessionTimeline.sessionSend', [{ conversationId: created.conversationId, text: 'original caption', files: [ref], clientRequestId: randomUUID() }], randomUUID());
    await until(() => prompts.length === 2 && fx.host.state().sessions[0]?.lastJobStatus === 'done', fx.events);
    assert.match(prompts[1], /^original caption\n\n/);
    assert.match(prompts[1], /File not saved/);
    assert.ok(fx.events.some(event => event.type === 'host_log' && event.level === 'warn' && event.message.includes(ref.itemId) && event.message.includes(created.conversationId)));
    await fx.host.invoke('sessionTimeline.sessionSend', [{ conversationId: created.conversationId, text: 'following text', clientRequestId: randomUUID() }], randomUUID());
    await until(() => prompts.length === 3 && fx.host.state().sessions[0]?.lastJobStatus === 'done', fx.events);
    assert.equal(prompts[2], 'following text');
    await fx.host.close();
    const reopened = await openPhoneAgentStore(fx.root, ownerId), agent = Object.values(reopened.state.agents)[0];
    assert.equal(Object.keys(agent.fileInputs).length, 1);
    reopened.state.jobs = {}; await reopened.save();
    const timeline = createPhoneTimelineRuntime({ root: fx.root, store: reopened, authorize: async () => {} });
    try {
      const snapshot = await timeline.snapshot(agent, {});
      const item = snapshot.turns.flatMap(turn => turn.items).find(item => item.kind === 'message' && item.role === 'user' && item.files?.length);
      assert.equal(item.text, 'original caption');
      assert.deepEqual(item.files, [ref]);
      assert.doesNotMatch(JSON.stringify(item), /not saved|promptText/);
    } finally { await timeline.close(); }
  } finally { await fx.close(); }
});
