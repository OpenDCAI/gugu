// @vitest-environment jsdom
// 首次引导「走完」按账号记在这台设备上:记过的账号直接放行,同一台设备上别的账号读不到这一笔。
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ identityDb: {} }))
vi.mock('../../../../apps/desktop/src/lib/identityReadAdapter', () => ({ readOwnOnboardedAt: vi.fn() }))

const { firstRunDoneHere, rememberFirstRunDone } = await import('../../../../apps/desktop/src/lib/firstRun')

afterEach(() => localStorage.clear())

describe('first run finished on this device', () => {
  it('is remembered per account: the account that finished gets in, another account on the same device does not', () => {
    expect(firstRunDoneHere('u1')).toBe(false)
    rememberFirstRunDone('u1')
    expect(firstRunDoneHere('u1')).toBe(true)
    expect(firstRunDoneHere('u2')).toBe(false)
  })
})
