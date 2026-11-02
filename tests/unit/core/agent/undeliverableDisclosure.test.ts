import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleAgentDeliverDeviceCommand } from '@gugu/core/local/agent/deviceCommandRuntime'

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

async function deliverToMissingAgent(isWhisper: boolean) {
  const home = mkdtempSync(join(tmpdir(), 'undeliverable-'))
  homes.push(home)
  const rows: unknown[] = []
  const failure = await handleAgentDeliverDeviceCommand(
    { agent_user_id: 'agent', chat_id: 'chat', message_id: 'message', thread_root_id: null, is_whisper: isWhisper },
    { accessToken: 'token', ownerUserId: 'owner', readerDeps: { postDisclosure: async (row: unknown) => { rows.push(row) } } } as never,
    { GUGU_HOME: home } as NodeJS.ProcessEnv,
  ).catch((error: unknown) => error as { disclosedInChat?: boolean })
  return { rows, failure: failure as { disclosedInChat?: boolean } }
}

describe('a message for an agent no instance on this device holds', () => {
  it('says so in the source chat', async () => {
    const { rows, failure } = await deliverToMissingAgent(false)
    expect(rows).toEqual([expect.objectContaining({ chatId: 'chat', reason: 'undelivered', key: 'undeliverable:agent:message' })])
    expect(failure.disclosedInChat).toBe(true)
  })

  it('says nothing in the chat about a whisper: the row is public, and would tell everyone who was whispered to', async () => {
    const { rows, failure } = await deliverToMissingAgent(true)
    expect(rows).toEqual([])
    expect(failure.disclosedInChat).toBe(false)
  })
})
