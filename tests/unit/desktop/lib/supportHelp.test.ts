import { describe, expect, it, vi } from 'vitest'
import { readHelpInfo, readHelpJoin } from '../../../../apps/desktop/src/components/supportHelp/contract'

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ identityDb: { rpc } }))
import { fetchSupportHelp, joinSupportHelp } from '../../../../apps/desktop/src/components/supportHelp/api'

function enabled() {
  return { support_help_entry_enabled: true as const, version: 2,
    group: { id: 'test-group', public_id: 123456, name: 'Test support', join_mode: 'approval' as const,
      is_member: false, join_request_status: null, availability: 'available' as const },
    duty_human: { id: 'test-duty', display_name: 'Duty human' }, assistants: [] }
}
describe('support help release contract', () => {
  it.each([undefined, null, false, 1, 'true'])('never opens for a non-true gate (%s)', (flag) => {
    expect(readHelpInfo({ ...enabled(), support_help_entry_enabled: flag })).toEqual({ support_help_entry_enabled: false })
  })
  it('requires configured group even with an enabled gate', () => {
    expect(readHelpInfo({ support_help_entry_enabled: true })).toEqual({ support_help_entry_enabled: false })
  })
  it('accepts minimal anonymous preview without a stable group ID or duty identities', () => {
    const preview = enabled()
    expect(readHelpInfo({ ...preview, group: { ...preview.group, id: null }, duty_human: null })).toMatchObject({ support_help_entry_enabled: true, group: { id: null } })
  })
  it('rejects malformed enabled configuration instead of guessing membership or joining mode', () => {
    expect(() => readHelpInfo({ ...enabled(), group: { ...enabled().group, join_mode: 'automatic' } })).toThrow()
    expect(() => readHelpInfo({ ...enabled(), version: -1 })).toThrow()
    expect(() => readHelpInfo({ ...enabled(), assistants: null })).toThrow()
  })
  it('accepts revalidation results without converting pending or switched configuration into joined', () => {
    for (const status of ['pending', 'config_changed', 'unavailable']) {
      expect(readHelpJoin({ status, info: enabled() })).toMatchObject({ status })
    }
    expect(() => readHelpJoin({ status: 'joined' })).toThrow()
  })
  it('passes only displayed version and stable group ID to the server; never invitation material', async () => {
    rpc.mockResolvedValueOnce({ data: { status: 'pending', info: enabled() }, error: null })
    await expect(joinSupportHelp(enabled())).resolves.toMatchObject({ status: 'pending' })
    expect(rpc).toHaveBeenLastCalledWith('official_help_join', { p_expected_version: 2, p_expected_group_id: 'test-group' })
  })
  it('does not join an anonymous preview', async () => {
    const before = rpc.mock.calls.length
    await expect(joinSupportHelp({ ...enabled(), group: { ...enabled().group, id: null } })).rejects.toThrow('Sign in')
    expect(rpc.mock.calls).toHaveLength(before)
  })
  it('never surfaces backend response text in errors', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'private server details' } })
    await expect(fetchSupportHelp()).rejects.toThrow('Support help could not be loaded')
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'private server details' } })
    await expect(joinSupportHelp(enabled())).rejects.toThrow('Support help could not be joined')
  })
})
