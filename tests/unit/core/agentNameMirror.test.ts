import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAgent, listAgents, writeAgentName } from '@gugu/core/local/state/agents'

// The roster record is this device's mirror of an agent identity's name; writeAgentName is its only writer.
let env: NodeJS.ProcessEnv
beforeEach(async () => {
  env = { GUGU_HOME: await mkdtemp(join(tmpdir(), 'agent-name-mirror-')) }
  await createAgent({ name: 'Codex 1', agent_type: 'codex', path: '/w', prompt: '', gugu_user_id: 'agent-1' }, env)
})
afterEach(async () => { await rm(env.GUGU_HOME!, { recursive: true, force: true }) })

const read = async () => {
  const agent = (await listAgents(env)).find((row) => row.gugu_user_id === 'agent-1')!
  return { name: agent.name, pending: agent.cache?.name_pending === true }
}

describe('agent name mirror', () => {
  it('a local rename is pending until that exact name is published', async () => {
    expect(await writeAgentName('agent-1', 'Parser', 'local', env)).toBe(true)
    expect(await read()).toEqual({ name: 'Parser', pending: true })
    // An answer for an older local name does not settle the newer one.
    await writeAgentName('agent-1', 'Parser v2', 'local', env)
    expect(await writeAgentName('agent-1', 'Parser', 'published', env)).toBe(false)
    expect(await read()).toEqual({ name: 'Parser v2', pending: true })
    await writeAgentName('agent-1', 'Parser v2', 'published', env)
    expect(await read()).toEqual({ name: 'Parser v2', pending: false })
  })

  it('an old cloud name cannot overwrite a pending local name; once published, the cloud is authoritative', async () => {
    await writeAgentName('agent-1', 'Offline name', 'local', env)
    expect(await writeAgentName('agent-1', 'Codex 1', 'cloud', env)).toBe(false)
    expect(await read()).toEqual({ name: 'Offline name', pending: true })
    await writeAgentName('agent-1', 'Offline name', 'published', env)
    expect(await writeAgentName('agent-1', 'Renamed elsewhere', 'cloud', env)).toBe(true)
    expect(await read()).toEqual({ name: 'Renamed elsewhere', pending: false })
  })

  it('refuses an empty name and an unknown agent loudly', async () => {
    await expect(writeAgentName('agent-1', '  ', 'local', env)).rejects.toThrow(/empty name/)
    await expect(writeAgentName('nobody', 'X', 'cloud', env)).rejects.toThrow(/does not exist/)
  })
})
