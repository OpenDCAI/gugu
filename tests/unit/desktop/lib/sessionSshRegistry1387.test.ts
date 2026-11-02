import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deferred } from '../../../support/testHarness'

const host = vi.hoisted(() => ({
  owner: null as string | null,
  authListener: (_event: string, _session: Session | null) => {},
  write: vi.fn(), clear: vi.fn(), invoke: vi.fn(), warn: vi.fn(),
  files: { attachmentUploadBegin: vi.fn(), attachmentUploadStatus: vi.fn(), attachmentUploadWrite: vi.fn(), attachmentUploadCommit: vi.fn(), attachmentUploadAbort: vi.fn() },
}))
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ warn: host.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }) }))
vi.mock('@/lib/auth', () => ({ hydrateIdentityAuthUser: async (user: { id: string }) => ({ id: user.id, email: '', nickname: 'Owner' }) }))
vi.mock('@/lib/phoneHostAuth', () => ({ phoneHostAuthAvailable: () => false,
  phoneHostGetSession: (fallback: () => unknown) => fallback(), phoneHostRefreshSession: (_token: string, fallback: () => unknown) => fallback(),
  phoneHostRestoreSession: (fallback: () => unknown) => fallback(), phoneHostSignOut: (fallback: () => unknown) => fallback(), setPhoneHostAuthHandoffBarrier: () => {} }))
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: {
    getSession: () => new Promise(() => {}),
    getUser: async () => ({ data: { user: session().user }, error: null }),
    refreshSession: async () => ({ data: { session: session('renewed') }, error: null }),
    onAuthStateChange: (listener: typeof host.authListener) => { host.authListener = listener; return { data: { subscription: { unsubscribe() {} } } } },
    signOut: async () => ({ error: null }),
  } },
  mainAuthSessionStorage: { getState: () => ({ bootCandidate: null, warning: null }), commit: async () => {}, remove: async () => {} },
}))
vi.mock('@/platform', () => ({ platform: { capabilities: { localHumanAuthSession: true }, writeHumanAuthSession: host.write,
  clearHumanAuthSession: host.clear, subscribeAppForeground: () => () => {} } }))
vi.mock('@/session/shared/remote-hosts', () => ({ findRemoteHostsBridge: () => ({ listDevices: () => [{ id: 'remote-host', connectVia: 'ssh' }] }) }))
vi.mock('@/store/devicesCache', () => ({ readCachedDevices: () => [{ device_id: 'remote-host', capabilities: { remote_protocol: 17 } }] }))
vi.mock('@/session/renderer/lib/ipc', () => ({ rpcOn: () => ({ workspace: { files: host.files } }) }))
vi.mock('@/session/renderer/features/remote-hosts/workspace/remote-transfer-wiring', () => ({ transfersFor: vi.fn() }))

function session(token = 'initial'): Session {
  return { access_token: token, refresh_token: token, token_type: 'bearer', expires_in: 3600,
    user: { id: 'owner', email: 'owner@example.test', aud: 'authenticated', role: 'authenticated', user_metadata: {}, app_metadata: {}, created_at: '' } } as Session
}
let directory = '', stop = () => {}
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); host.owner = null
  directory = mkdtempSync(join(tmpdir(), 'gugu-ssh-registry-'))
  const file = join(directory, 'ssh-machines.json')
  writeFileSync(file, JSON.stringify({ version: 1, machines: [{ deviceId: 'remote-host', ownerUserId: 'owner', destination: 'localhost', display: 'localhost', addedAt: '2026-11-01T00:00:00Z' }] }))
  const { createSshMachineStore, registerSshMachinesIpc } = await import('../../../../apps/desktop/electron/server/ssh-machines')
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerSshMachinesIpc({ ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } as unknown as Electron.IpcMain,
    getWindow: () => null, store: createSshMachineStore(file), currentUserId: async () => host.owner })
  host.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel); if (!handler) throw Error(`Unknown test IPC: ${channel}`)
    return handler({}, ...args)
  })
  host.write.mockImplementation(async (mirror: { user_id: string }) => { host.owner = mirror.user_id })
  host.clear.mockImplementation(async () => { host.owner = null })
  vi.stubGlobal('window', { electronAPI: { invoke: host.invoke, eventOn: () => () => {} } })
  const state = { state: 'uploading', total: 3, received: 0, chunkBytes: 128 * 1024, workspacePath: '.gugu/attachments/item-12345678/shot.png' }
  host.files.attachmentUploadBegin.mockResolvedValue({ success: true, data: state })
  host.files.attachmentUploadWrite.mockResolvedValue({ success: true, data: { ...state, received: 3 } })
  host.files.attachmentUploadCommit.mockResolvedValue({ success: true, data: { ...state, state: 'committed', received: 3 } })
})
afterEach(() => { stop(); stop = () => {}; vi.unstubAllGlobals(); rmSync(directory, { recursive: true, force: true }) })

describe('SSH registry after desktop authentication (#1387)', () => {
  it('restores the saved SSH machine after INITIAL_SESSION and sends the image over SSH', async () => {
    const ssh = await import('../../../../apps/desktop/src/lib/sshLinkChannel')
    const { pushTaskAttachment } = await import('../../../../apps/desktop/src/lib/taskAttachmentTarget')
    const to = { deviceId: 'remote-host', projectId: 'project', workspaceId: 'workspace', chatId: 'chat', owner: 'owner' }
    const file = { itemId: 'item-12345678', version: 1, name: 'shot.png', mimeType: 'image/png', sizeBytes: 3 }
    await ssh.sshMachinesReady()
    expect(ssh.isSshMachine('remote-host')).toBe(false)
    await expect(pushTaskAttachment(to, file, new Blob(['abc']), {})).rejects.toThrow('no SSH connection')
    const { sessionCoordinator } = await import('../../../../apps/desktop/src/lib/sessionCoordinator')
    stop = sessionCoordinator.start()
    host.authListener('INITIAL_SESSION', session())
    await vi.waitFor(() => expect(host.write).toHaveBeenCalledOnce())
    await expect(pushTaskAttachment(to, file, new Blob(['abc']), {})).resolves.toBe('.gugu/attachments/item-12345678/shot.png')
    expect(ssh.isSshMachine('remote-host')).toBe(true)
    expect(host.files.attachmentUploadWrite).toHaveBeenCalledOnce()
  })

  it('reads again only after the host acknowledges a TOKEN_REFRESHED mirror, and clears on sign-out', async () => {
    const ssh = await import('../../../../apps/desktop/src/lib/sshLinkChannel')
    const { sessionCoordinator } = await import('../../../../apps/desktop/src/lib/sessionCoordinator')
    stop = sessionCoordinator.start()
    await sessionCoordinator.acceptInteractiveSession(sessionCoordinator.beginInteractiveLogin(), session())
    await ssh.refreshSshMachines()
    const calls = host.invoke.mock.calls.length
    const acknowledged = deferred<void>(), entered = deferred<void>()
    host.write.mockImplementationOnce(async () => { entered.resolve(); await acknowledged.promise })
    const refreshed = sessionCoordinator.refresh()
    await entered.promise
    expect(host.invoke).toHaveBeenCalledTimes(calls)
    acknowledged.resolve(); await refreshed
    expect(host.invoke).toHaveBeenCalledTimes(calls + 1)
    await expect(sessionCoordinator.logout()).resolves.toEqual({ success: true })
    expect(ssh.isSshMachine('remote-host')).toBe(false)
  })

  it('does not cache an IPC failure as a successful empty registry, and logs the reason before retry', async () => {
    const ssh = await import('../../../../apps/desktop/src/lib/sshLinkChannel')
    host.owner = 'owner'
    host.invoke.mockRejectedValueOnce(new Error('IPC channel unavailable'))
    await expect(ssh.sshMachinesReady()).rejects.toThrow('IPC channel unavailable')
    expect(host.warn).toHaveBeenCalledWith(expect.objectContaining({ error: 'IPC channel unavailable' }), expect.any(String))
    await ssh.sshMachinesReady()
    expect(host.invoke).toHaveBeenCalledTimes(2)
    expect(ssh.isSshMachine('remote-host')).toBe(true)
  })

  it('retries a failed refresh even after a previous registry read succeeded', async () => {
    const ssh = await import('../../../../apps/desktop/src/lib/sshLinkChannel')
    host.owner = 'owner'; await ssh.sshMachinesReady()
    host.invoke.mockRejectedValueOnce(new Error('refresh IPC failed'))
    await expect(ssh.refreshSshMachines()).rejects.toThrow('refresh IPC failed')
    await ssh.sshMachinesReady()
    expect(host.invoke).toHaveBeenCalledTimes(3)
    expect(ssh.isSshMachine('remote-host')).toBe(true)
  })

  it('does not let a late pre-login empty reply overwrite the post-login registry', async () => {
    const ssh = await import('../../../../apps/desktop/src/lib/sshLinkChannel')
    const initial = deferred<string[]>()
    host.invoke.mockImplementationOnce(() => initial.promise)
    const early = ssh.sshMachinesReady()
    await vi.waitFor(() => expect(host.invoke).toHaveBeenCalledOnce())
    host.owner = 'owner'; await ssh.refreshSshMachines()
    initial.resolve([]); await early
    expect(ssh.isSshMachine('remote-host')).toBe(true)
  })
})
