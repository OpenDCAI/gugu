// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleRendererRpcEvent, useRendererRpcHandlers } from '../../../../apps/desktop/src/rpc-renderer/rendererRpc'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function commandEvent(method: string, params: unknown = null): CustomEvent {
  return new CustomEvent('rpc', {
    detail: {
      reqId: 'req-1',
      method,
      params,
    },
  })
}

function hookCommandEvent(method: string, params: unknown = null): CustomEvent {
  return new CustomEvent('rpc-hook-test', {
    detail: {
      reqId: 'req-1',
      method,
      params,
    },
  })
}

describe('renderer RPC event handling', () => {
  it('routes a command to the matching handler and responds with its result', async () => {
    const respond = vi.fn()

    await handleRendererRpcEvent(commandEvent('ping', { value: 1 }), 'test', {
      ping: (params) => ({ success: true, params }),
    }, respond)

    expect(respond).toHaveBeenCalledWith('req-1', {
      success: true,
      params: { value: 1 },
    })
  })

  it('an unknown method fails the same way a throwing handler does', async () => {
    const respond = vi.fn()

    await handleRendererRpcEvent(commandEvent('missing'), 'chat', {}, respond)

    expect(respond).toHaveBeenCalledWith('req-1', {
      __rendererRpcError: true,
      error: 'Unknown chat method: missing',
    })
  })

  it('wraps handler exceptions for the Electron bridge', async () => {
    const respond = vi.fn()

    await handleRendererRpcEvent(commandEvent('fail'), 'chat', {
      fail: () => {
        throw new Error('boom')
      },
    }, respond)

    expect(respond).toHaveBeenCalledWith('req-1', {
      __rendererRpcError: true,
      error: 'boom',
    })
  })
})

describe('renderer RPC hook registration', () => {
  const mountedRoots: Array<ReturnType<typeof createRoot>> = []
  const mountedContainers: HTMLElement[] = []

  afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
      act(() => root.unmount())
    }
    for (const container of mountedContainers.splice(0)) {
      container.remove()
    }
  })

  async function mountHook(
    enabled: boolean,
    respond: (reqId: string, result: unknown) => void,
    declareReady?: () => void,
  ): Promise<void> {
    function TestHarness() {
      useRendererRpcHandlers('rpc-hook-test', 'test', {
        ping: () => ({ success: true }),
      }, respond, enabled, declareReady)
      return null
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    mountedContainers.push(container)
    mountedRoots.push(root)

    await act(async () => {
      root.render(createElement(TestHarness))
    })
  }

  it('does not register window listeners when disabled', async () => {
    const respond = vi.fn()
    const declareReady = vi.fn()

    await mountHook(false, respond, declareReady)
    window.dispatchEvent(hookCommandEvent('ping'))

    expect(respond).not.toHaveBeenCalled()
    expect(declareReady).not.toHaveBeenCalled()
  })

  it('registers window listeners when enabled', async () => {
    const respond = vi.fn()

    await mountHook(true, respond)
    window.dispatchEvent(hookCommandEvent('ping'))
    await Promise.resolve()

    expect(respond).toHaveBeenCalledWith('req-1', { success: true })
  })

  it('declares ready only after the command listener can receive', async () => {
    const respond = vi.fn()
    const declareReady = vi.fn(() => {
      window.dispatchEvent(hookCommandEvent('ping'))
    })

    await mountHook(true, respond, declareReady)
    await Promise.resolve()

    expect(declareReady).toHaveBeenCalledOnce()
    expect(respond).toHaveBeenCalledWith('req-1', { success: true })
  })
})
