import { describe, expect, it, vi } from 'vitest'

vi.mock('@gugu/core/cloud/config', () => ({ getSupabaseUrl: () => 'https://db.test', getSupabaseAnonKey: () => 'anon' }))
// The data clients carry no auth session of their own (accessToken option): asking one for its session throws. The
// token is the one the session coordinator published — the same one every data request uses.
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  dataClient: { auth: { getSession: () => { throw new Error('Supabase Client is configured with the accessToken option') } } },
}))

const { publishRendererSession } = await import('../../../../apps/desktop/src/lib/sessionPublication')
const { attachmentsEndpoint } = await import('../../../../apps/desktop/src/lib/attachmentsEndpoint')

describe('attachmentsEndpoint: the attachments function, with the token the session coordinator published', () => {
  it('signed out ⇒ said; signed in ⇒ that token, this build\'s server', async () => {
    await expect(attachmentsEndpoint()).rejects.toThrow(/not signed in/)
    publishRendererSession('SIGNED_IN', { access_token: 'published-token', user: { id: 'u1' } } as never)
    await expect(attachmentsEndpoint()).resolves.toEqual({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'published-token' })
  })
})
