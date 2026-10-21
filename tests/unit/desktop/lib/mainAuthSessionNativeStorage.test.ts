// @vitest-environment jsdom
import type { Session } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionCoordinator, type SessionCoordinatorDeps } from '../../../../apps/desktop/src/lib/sessionCoordinator'
type SdkMutationStorage = {
  setItem(key: string, value: string): void
  removeItem(key: string): void
}
const sdkMutationStorage = (storage: unknown): SdkMutationStorage => storage as SdkMutationStorage
const native = vi.hoisted(() => ({
  value: null as string | null,
  get: vi.fn(async () => ({ value: native.value })),
  write: vi.fn(async ({ value }: { key: string; value: string }) => { native.value = value }),
}))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({ get: native.get, write: native.write }),
}))
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: vi.fn(() => ({ auth: {} })) }))
function session(id: string, suffix = 'old'): Session {
  return {
    access_token: `access-${id}-${suffix}`,
    refresh_token: `refresh-${id}-${suffix}`,
    user: { id },
  } as Session
}
async function loadStorage() {
  vi.resetModules()
  return import('../../../../apps/desktop/src/lib/supabase')
}
describe('mainAuthSessionStorage native state agent', () => {
  beforeEach(() => {
    window.localStorage.clear()
    native.value = null
    native.get.mockClear()
    native.write.mockClear()
  })
  afterEach(() => vi.restoreAllMocks())
  it('durably establishes RETIRED_EMPTY before projecting definitive null', async () => {
    const { MAIN_AUTH_STORAGE_KEY, mainAuthSessionStorage } = await loadStorage()
    await expect(Promise.resolve(mainAuthSessionStorage.storage.getItem(MAIN_AUTH_STORAGE_KEY))).resolves.toBeNull()
    expect(JSON.parse(native.value!)).toEqual({ state: 'RETIRED_EMPTY' })
    expect(native.write).toHaveBeenCalledTimes(1)
  })
  it('clears stale B projection when physical absence initializes a tombstone', async () => {
    const { MAIN_AUTH_STORAGE_KEY, mainAuthSessionStorage } = await loadStorage()
    await mainAuthSessionStorage.commit(session('user-b'), new AbortController().signal)
    native.value = null
    await expect(Promise.resolve(mainAuthSessionStorage.storage.getItem(MAIN_AUTH_STORAGE_KEY))).resolves.toBeNull()
    expect(mainAuthSessionStorage.getState().bootCandidate).toBeNull()
    const deps: SessionCoordinatorDeps = {
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
      refreshSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      restoreSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut: vi.fn(async () => ({ error: null })),
      hydrateUser: vi.fn(async () => null),
      publishSession: vi.fn(),
      writeMirror: vi.fn(async () => {}),
      clearMirror: vi.fn(async () => {}),
      getPersistedSessionState: mainAuthSessionStorage.getState,
      commitPersistedSession: mainAuthSessionStorage.commit,
      clearPersistedSession: mainAuthSessionStorage.remove,
      subscribeAppForeground: () => () => {},
    }
    const coordinator = new SessionCoordinator(deps)
    coordinator.start()
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe('anonymous'))
  })
  it('publishes migrated legacy only after the native SESSION commit settles', async () => {
    const legacy = JSON.stringify(session('legacy'))
    window.localStorage.setItem('sb-main', legacy)
    let finishCommit!: () => void
    native.write.mockImplementationOnce(({ value }: { key: string; value: string }) => new Promise<void>((resolve) => {
      finishCommit = () => { native.value = value; resolve() }
    }))
    const { MAIN_AUTH_STORAGE_KEY, mainAuthSessionStorage } = await loadStorage()
    let settled = false
    const projected = Promise.resolve(mainAuthSessionStorage.storage.getItem(MAIN_AUTH_STORAGE_KEY))
      .then((value) => { settled = true; return value })
    await vi.waitFor(() => expect(finishCommit).toBeTypeOf('function'))
    expect(settled).toBe(false)
    finishCommit()
    await expect(projected).resolves.toBe(legacy)
    expect(JSON.parse(native.value!)).toEqual({ state: 'SESSION', raw: legacy })
  })
  it('retains a concurrently replaced legacy B and retries the original A comparison', async () => {
    const legacyA = JSON.stringify(session('user-a'))
    const legacyB = JSON.stringify(session('user-b'))
    window.localStorage.setItem('sb-main', legacyA)
    let finishCommit!: () => void
    native.write.mockImplementationOnce(({ value }: { key: string; value: string }) => new Promise<void>((resolve) => {
      finishCommit = () => { native.value = value; resolve() }
    }))
    const { MAIN_AUTH_STORAGE_KEY, mainAuthSessionStorage } = await loadStorage()
    const projected = Promise.resolve(mainAuthSessionStorage.storage.getItem(MAIN_AUTH_STORAGE_KEY))
    await vi.waitFor(() => expect(finishCommit).toBeTypeOf('function'))
    window.localStorage.setItem(MAIN_AUTH_STORAGE_KEY, legacyB)
    finishCommit()
    await expect(projected).resolves.toBe(legacyA)
    expect(window.localStorage.getItem(MAIN_AUTH_STORAGE_KEY)).toBe(legacyB)
    expect(mainAuthSessionStorage.getState().warning).toBeInstanceOf(Error)
    await mainAuthSessionStorage.commit(session('user-a'), new AbortController().signal)
    expect(window.localStorage.getItem(MAIN_AUTH_STORAGE_KEY)).toBe(legacyB)
  })
  it('keeps malformed legacy bytes loud without creating native truth', async () => {
    window.localStorage.setItem('sb-main', '{"user":')
    const { MAIN_AUTH_STORAGE_KEY, mainAuthSessionStorage } = await loadStorage()
    await expect(Promise.resolve(mainAuthSessionStorage.storage.getItem(MAIN_AUTH_STORAGE_KEY))).rejects.toThrow()
    expect(native.write).not.toHaveBeenCalled()
    expect(window.localStorage.getItem('sb-main')).toBe('{"user":')
  })
  it('commits RETIRED_EMPTY before terminal publication and defeats legacy on restart', async () => {
    const active = session('user-b')
    const { MAIN_AUTH_STORAGE_KEY, mainAuthSessionStorage } = await loadStorage()
    await mainAuthSessionStorage.commit(active, new AbortController().signal)
    window.localStorage.setItem(MAIN_AUTH_STORAGE_KEY, JSON.stringify(session('user-a')))
    await mainAuthSessionStorage.remove(active, new AbortController().signal)
    expect(JSON.parse(native.value!)).toEqual({ state: 'RETIRED_EMPTY' })
    const restarted = await loadStorage()
    await expect(Promise.resolve(restarted.mainAuthSessionStorage.storage.getItem(MAIN_AUTH_STORAGE_KEY))).resolves.toBeNull()
  })
  it('retains exact SESSION after a failed tombstone commit and ignores SDK mutation', async () => {
    const active = session('user-b')
    const { MAIN_AUTH_STORAGE_KEY, mainAuthSessionStorage } = await loadStorage()
    await mainAuthSessionStorage.commit(active, new AbortController().signal)
    const committed = native.value
    native.write.mockRejectedValueOnce(new Error('commit false'))
    await expect(mainAuthSessionStorage.remove(active, new AbortController().signal)).rejects.toThrow('commit false')
    sdkMutationStorage(mainAuthSessionStorage.storage).removeItem(MAIN_AUTH_STORAGE_KEY)
    sdkMutationStorage(mainAuthSessionStorage.storage).setItem(MAIN_AUTH_STORAGE_KEY, JSON.stringify(session('user-a')))
    expect(native.value).toBe(committed)
    await expect(Promise.resolve(mainAuthSessionStorage.storage.getItem(MAIN_AUTH_STORAGE_KEY))).resolves.toBe(JSON.stringify(active))
  })
  it('advances persisted projection A to B and clears it only after terminal commit', async () => {
    const { mainAuthSessionStorage } = await loadStorage()
    await mainAuthSessionStorage.commit(session('user-a'), new AbortController().signal)
    await mainAuthSessionStorage.commit(session('user-b'), new AbortController().signal)
    expect(mainAuthSessionStorage.getState().bootCandidate?.user.id).toBe('user-b')
    await mainAuthSessionStorage.remove(session('user-b'), new AbortController().signal)
    expect(mainAuthSessionStorage.getState().bootCandidate).toBeNull()
  })
  it('rejects absent, mismatched, and malformed terminal state but accepts tombstone idempotently', async () => {
    const { mainAuthSessionStorage } = await loadStorage()
    await expect(mainAuthSessionStorage.remove(session('user-a'), new AbortController().signal)).rejects.toThrow('uninitialized')
    native.value = JSON.stringify({ state: 'SESSION', raw: JSON.stringify(session('user-b')) })
    await expect(mainAuthSessionStorage.remove(session('user-a'), new AbortController().signal)).rejects.toThrow('changed')
    native.value = '{"state":"SESSION"}'
    await expect(mainAuthSessionStorage.remove(session('user-a'), new AbortController().signal)).rejects.toThrow('Malformed')
    native.value = JSON.stringify({ state: 'RETIRED_EMPTY' })
    native.write.mockClear()
    await expect(mainAuthSessionStorage.remove(session('user-a'), new AbortController().signal)).resolves.toBeUndefined()
    expect(native.write).not.toHaveBeenCalled()
  })
  it.each([
    { state: 'RETIRED_EMPTY', raw: 'contradiction' },
    { state: 'SESSION', raw: JSON.stringify({ ...session('user-a'), access_token: '' }) },
    { state: 'UNKNOWN' },
  ])('rejects contradictory or incomplete envelope %#', async (value) => {
    native.value = JSON.stringify(value)
    window.localStorage.setItem('sb-main', JSON.stringify(session('legacy')))
    const remove = vi.spyOn(window.localStorage, 'removeItem')
    const { MAIN_AUTH_STORAGE_KEY, mainAuthSessionStorage } = await loadStorage()
    await expect(Promise.resolve(mainAuthSessionStorage.storage.getItem(MAIN_AUTH_STORAGE_KEY))).rejects.toThrow('Malformed')
    expect(remove).not.toHaveBeenCalled()
  })
  it('retries observable hygiene failure on the next storage invocation', async () => {
    native.value = JSON.stringify({ state: 'SESSION', raw: JSON.stringify(session('user-b')) })
    window.localStorage.setItem('sb-main', JSON.stringify(session('legacy')))
    const remove = vi.spyOn(window.localStorage, 'removeItem')
      .mockImplementationOnce(() => { throw new Error('locked') })
    const { MAIN_AUTH_STORAGE_KEY, mainAuthSessionStorage } = await loadStorage()
    await mainAuthSessionStorage.storage.getItem(MAIN_AUTH_STORAGE_KEY)
    expect(mainAuthSessionStorage.getState().warning).toBeInstanceOf(Error)
    await mainAuthSessionStorage.storage.getItem(MAIN_AUTH_STORAGE_KEY)
    expect(mainAuthSessionStorage.getState().warning).toBeNull()
    expect(remove).toHaveBeenCalledTimes(2)
  })
  it('keeps non-main SDK keys isolated and continues the queue after rejection', async () => {
    const { MAIN_AUTH_STORAGE_KEY, mainAuthSessionStorage } = await loadStorage()
    await expect(Promise.resolve(mainAuthSessionStorage.storage.getItem('other'))).resolves.toBeNull()
    sdkMutationStorage(mainAuthSessionStorage.storage).setItem('other', 'value')
    sdkMutationStorage(mainAuthSessionStorage.storage).removeItem('other')
    expect(native.get).not.toHaveBeenCalled()
    expect(native.write).not.toHaveBeenCalled()
    native.write.mockRejectedValueOnce(new Error('commit false'))
    await expect(mainAuthSessionStorage.commit(session('user-a'), new AbortController().signal)).rejects.toThrow('commit false')
    await mainAuthSessionStorage.commit(session('user-b'), new AbortController().signal)
    expect(mainAuthSessionStorage.getState().bootCandidate?.user.id).toBe('user-b')
    await expect(Promise.resolve(mainAuthSessionStorage.storage.getItem(MAIN_AUTH_STORAGE_KEY))).resolves.toBe(JSON.stringify(session('user-b')))
  })
  it('propagates a native read rejection and leaves the ordered queue usable', async () => {
    native.get.mockRejectedValueOnce(new Error('native read failed'))
    const { MAIN_AUTH_STORAGE_KEY, mainAuthSessionStorage } = await loadStorage()
    await expect(Promise.resolve(mainAuthSessionStorage.storage.getItem(MAIN_AUTH_STORAGE_KEY))).rejects.toThrow('native read failed')
    native.value = JSON.stringify({ state: 'RETIRED_EMPTY' })
    await expect(Promise.resolve(mainAuthSessionStorage.storage.getItem(MAIN_AUTH_STORAGE_KEY))).resolves.toBeNull()
  })
})
