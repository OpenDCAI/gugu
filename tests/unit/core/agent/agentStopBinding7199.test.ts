import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgent, getAgent, updateAgent } from '@gugu/core/local/state/agents'
import { handleAgentStopDeviceCommand, type AgentRuntimeBridge } from '@gugu/core/local/agent/deviceCommandRuntime'

const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

async function arrange(cache: Record<string, unknown>) {
  const home = await mkdtemp(join(tmpdir(), 'gugu-stop-binding-7199-'))
  homes.push(home)
  const env = { HOME: home, GUGU_HOME: join(home, '.gugu') }
  await createAgent({ name: '咕咕', agent_type: 'claude-code', path: '/assistant', gugu_user_id: 'assistant-1', prompt: '' }, env)
  await updateAgent({ guguUserId: 'assistant-1' }, { cache, terminal_container: 'old-runtime' }, env)
  const bridge: AgentRuntimeBridge = {
    create: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  }
  return { env, bridge }
}

describe('agent.stop keeps the assistant addressable after a move (#7199)', () => {
  it('clears provider runtime handles while retaining session, owner, group and model bindings', async () => {
    const binding = {
      emdash_session_id: 'session-1', emdash_project_id: 'project-1',
      sessionpage_owner_user_id: 'owner-1', sessionpage_group_chat_id: 'group-1',
      sessionpage_direct_chat_id: 'dm-1', sessionpage_provider_id: 'claude-code',
      sessionpage_session_surface: 'acp', model_access: { mode: 'byok' },
    }
    const { env, bridge } = await arrange({ ...binding, provider_session_id: 'old-provider', provider_pid: 123 })
    const report = vi.fn()
    await handleAgentStopDeviceCommand({ agent_user_id: 'assistant-1' }, { runtimeBridge: bridge, reportRuntimeState: report }, env)
    const stopped = await getAgent({ guguUserId: 'assistant-1' }, env)
    expect(stopped?.cache).toEqual(binding)
    expect(stopped?.terminal_container).toBeNull()
    expect(bridge.stop).toHaveBeenCalledWith({ agentUserId: 'assistant-1', engineId: 'claude' })
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ activityStatus: 'idle' }))
  })

  it('keeps changes made by the runtime while it stops instead of restoring an older roster snapshot', async () => {
    const { env, bridge } = await arrange({ emdash_session_id: 'session-1', sessionpage_child_harness: 'claude-code' })
    bridge.stop = vi.fn(async () => {
      await updateAgent({ guguUserId: 'assistant-1' }, { cache: { emdash_session_id: 'session-1', sessionpage_child_harness: 'pi' } }, env)
    })
    await handleAgentStopDeviceCommand({ agent_user_id: 'assistant-1' }, { runtimeBridge: bridge, reportRuntimeState: vi.fn() }, env)
    expect((await getAgent({ guguUserId: 'assistant-1' }, env))?.cache).toEqual({ emdash_session_id: 'session-1', sessionpage_child_harness: 'pi' })
  })
})
