import { describe, expect, it, vi } from 'vitest'
import {
  registerSessionpageSessionRuntime,
  teardownSessionpageSessionRuntimes,
} from '../../sessionpage/sessionpage-session-runtime-registry'

describe('taskpage session runtime registry', () => {
  it('tears down every registered runtime for the same conversation', async () => {
    const first = vi.fn().mockResolvedValue(undefined)
    const second = vi.fn().mockResolvedValue(undefined)
    registerSessionpageSessionRuntime({ name: 'test-first', teardown: first })
    registerSessionpageSessionRuntime({ name: 'test-second', teardown: second })

    await teardownSessionpageSessionRuntimes('conversation-1')

    expect(first).toHaveBeenCalledWith('conversation-1')
    expect(second).toHaveBeenCalledWith('conversation-1')
  })

  it('reports a failed runtime instead of hiding it', async () => {
    const failure = new Error('serve did not exit')
    registerSessionpageSessionRuntime({
      name: 'test-failure',
      teardown: vi.fn().mockRejectedValue(failure),
    })

    await expect(teardownSessionpageSessionRuntimes('conversation-2'))
      .rejects.toThrow('sessionpage runtime test-failure teardown failed for conversation-2')
  })
})
