import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

import { bindElectronSupabaseAuth, refreshElectronSupabaseAuth, supabase } from '../../../../apps/desktop/electron/supabase'

afterEach(() => {
  bindElectronSupabaseAuth(async () => null)
})

describe('Electron Realtime 的认证归当前账号', () => {
  it('新建和重连都现取当前登录态,续期直接更新同一条连接', async () => {
    let token: string | null = 'owner-old'
    const current = vi.fn(async () => token)
    bindElectronSupabaseAuth(current)
    await supabase.realtime.setAuth()
    expect(supabase.realtime.accessTokenValue).toBe('owner-old')
    token = 'owner-current'
    await refreshElectronSupabaseAuth()
    expect(supabase.realtime.accessTokenValue).toBe('owner-current')
    token = 'owner-next'
    await supabase.realtime.setAuth()
    expect(supabase.realtime.accessTokenValue).toBe('owner-next')
    token = null
    await refreshElectronSupabaseAuth()
    expect(supabase.realtime.accessTokenValue).toBeNull()
  })
})
