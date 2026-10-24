import { describe, expect, it, vi } from 'vitest'
import { createWebSessionShellAnswers } from '../../../../apps/desktop/src/lib/session-shell-web-answers'
import { answerSessionShellChannels, createSessionShellPort, type SessionShellPeer } from '../../../../apps/desktop/src/session/shared/lib/ipc/shell-port'

describe('web task reference directory', () => {
  it('returns the host canonical peers through the same shell port as desktop', async () => {
    const peers: SessionShellPeer[] = [{
      sessionId: 'private-task', engine: 'claude',
      identity: { users: { id: 'agent-id', display_name: 'Private task', gugu_number: null } },
    }]
    const hostInvoke = vi.fn(async () => peers)
    const port = createSessionShellPort(answerSessionShellChannels(hostInvoke, createWebSessionShellAnswers(hostInvoke)))

    expect(await port.sessionPeers()).toBe(peers)
    expect(hostInvoke).toHaveBeenCalledExactlyOnceWith('sessionpageIdentity.sessionPeers')
  })

  it('preserves a host rejection instead of treating it as an empty directory', async () => {
    const hostInvoke = vi.fn(async () => { throw new Error('owner not authenticated') })
    const port = createSessionShellPort(answerSessionShellChannels(hostInvoke, createWebSessionShellAnswers(hostInvoke)))

    await expect(port.sessionPeers()).rejects.toThrow('owner not authenticated')
  })
})
