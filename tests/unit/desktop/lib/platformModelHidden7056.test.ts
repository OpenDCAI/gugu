// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

// #7056 设置「模型」页的开关:连拨几下时,请求要按拨的顺序一个接一个落库 ——
// 后拨的先到,库里就停在与界面相反的那一边。前一个失败也不能把后面的卡死。
const invoke = vi.fn()
vi.mock('../../../../apps/desktop/src/lib/supabase', async () => {
  const actual = await vi.importActual<typeof import('../../../../apps/desktop/src/lib/supabase')>(
    '../../../../apps/desktop/src/lib/supabase',
  )
  return { ...actual, dataClient: { functions: { invoke: (...args: unknown[]) => invoke(...args) } } }
})

import { setPlatformModelHidden } from '../../../../apps/desktop/src/lib/agentModelSelection'
import { PLATFORM_MODELS_CHANGED_EVENT } from '../../../../apps/desktop/src/session/shared/core/agents/platform-model'

function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

afterEach(() => invoke.mockReset())

describe('setPlatformModelHidden', () => {
  it('sends one write at a time, in the order the switches were flipped', async () => {
    const first = deferred()
    invoke.mockImplementationOnce(() => first.promise).mockResolvedValue({ data: { hidden: [] }, error: null })

    const a = setPlatformModelHidden('grok-4.5', true)
    const b = setPlatformModelHidden('grok-4.5', false)
    await Promise.resolve()
    await Promise.resolve()
    // 第一下还没回来,第二下就不发。
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke.mock.calls[0][1]).toEqual({ body: { action: 'set_model_hidden', model_id: 'grok-4.5', hidden: true } })

    first.resolve({ data: { hidden: ['grok-4.5'] }, error: null })
    await Promise.all([a, b])
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke.mock.calls[1][1]).toEqual({ body: { action: 'set_model_hidden', model_id: 'grok-4.5', hidden: false } })
  })

  it('keeps going after a failed write and tells open pickers to refetch after each success', async () => {
    const changed = vi.fn()
    window.addEventListener(PLATFORM_MODELS_CHANGED_EVENT, changed)
    invoke
      .mockResolvedValueOnce({ data: null, error: new Error('boom') })
      .mockResolvedValueOnce({ data: { hidden: ['glm-5.3'] }, error: null })

    await expect(setPlatformModelHidden('grok-4.5', true)).rejects.toThrow('boom')
    await setPlatformModelHidden('glm-5.3', true)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(changed).toHaveBeenCalledTimes(1)
    window.removeEventListener(PLATFORM_MODELS_CHANGED_EVENT, changed)
  })
})
