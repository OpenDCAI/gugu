import { beforeEach, describe, expect, it, vi } from 'vitest'
import { displayIdentity } from '../../../support/testHarness'
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  readRequiredDisplayIdentities: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  identityDb: { rpc: mocks.rpc },
  dataClient: { schema: vi.fn(() => ({})) },
  chatDb: {},
  getCurrentAuthUserId: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/lib/identityReadAdapter', () => ({
  DISPLAY_IDENTITY_SELECT: 'canonical',
  readAgentProfileTypes: vi.fn(async () => []),
  readRequiredDisplayIdentities: mocks.readRequiredDisplayIdentities,
  readDisplayIdentities: vi.fn(),
  readOwnedDisplayIdentities: vi.fn(),
}))
import { contactsService } from '../../../../apps/desktop/src/lib/contacts'
describe('contact search canonical identity hydration', () => {
  beforeEach(() => vi.clearAllMocks())
  it('treats search_users rows as candidate ids and returns full adapter identities', async () => {
    const canonical = displayIdentity('candidate-1', { display_name: 'Canonical Alice', category: 'research' })
    mocks.rpc.mockResolvedValue({ data: [{ id: 'candidate-1', display_name: 'Narrow stale copy' }], error: null })
    mocks.readRequiredDisplayIdentities.mockResolvedValue([canonical])
    await expect(contactsService.searchUsers('alice', 'viewer-1')).resolves.toEqual([canonical])
    expect(mocks.readRequiredDisplayIdentities).toHaveBeenCalledWith(['candidate-1'])
  })
  it('fails loudly when a candidate has no full canonical row', async () => {
    mocks.rpc.mockResolvedValue({ data: [{ id: 'candidate-1' }], error: null })
    mocks.readRequiredDisplayIdentities.mockRejectedValue(new Error('Canonical identity candidate-1 was not returned'))
    await expect(contactsService.searchUsers('alice', 'viewer-1')).rejects.toThrow(/candidate-1/)
  })
  it.each(['P0001', '42501', '23505', 'PGRST204'])('keeps the %s contact RPC message and native cause for the UI', async (code) => {
    const error = { message: 'Contact lookup denied /Users/test/private sk-synthetic-secret\nstack detail', code }
    mocks.rpc.mockResolvedValue({ data: null, error })
    const caught = await contactsService.searchUsers('alice', 'viewer-1').catch((cause) => cause)
    expect(caught).toBeInstanceOf(Error)
    expect(caught.message).toBe(error.message)
    expect(caught.cause).toBe(error)
    const { messageForUser } = await import('../../../../apps/desktop/src/lib/userFacingError')
    expect(messageForUser(caught)).toBe('Contact lookup denied [path] [redacted token]')
  })

})
