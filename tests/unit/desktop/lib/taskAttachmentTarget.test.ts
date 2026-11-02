import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ devices: [] as Array<{ id: string; connectVia?: string; directTerminal?: boolean }>,
  cached: [] as Array<{ device_id: string; is_online?: boolean; capabilities?: { remote_protocol?: number } }>,
  hello: { protocol: 5 } as { protocol: number } | null, rpc: vi.fn(),
  files: { writeChunk: vi.fn(), getAbsolutePath: vi.fn(), createEntry: vi.fn() }, upload: vi.fn(), items: [] as Array<{ name: string; done: number; status: string; cancel: () => void }> }))
vi.mock('@/session/shared/remote-hosts', () => ({ findRemoteHostsBridge: () => ({ listDevices: () => mocks.devices }) }))
vi.mock('@/session/renderer/lib/ipc', () => ({ rpcOn: () => ({ workspace: { files: mocks.files } }) }))
vi.mock('@/session/renderer/lib/machine-clients', () => ({ machineClient: () => ({ hello: () => mocks.hello }) }))
vi.mock('@/session/renderer/lib/machine-routing', () => ({ machineCodec: () => ({ outbound: (value: unknown) => value }) }))
vi.mock('@/session/renderer/features/remote-hosts/workspace/remote-transfer-wiring', () => ({ transfersFor: () => ({ upload: mocks.upload, get items() { return mocks.items } }) }))
vi.mock('@/store/devicesCache', () => ({ readCachedDevices: () => mocks.cached }))
vi.mock('@/lib/deviceRpc', () => ({ callDeviceRpc: mocks.rpc }))

import { prefetchTaskFiles, pushTaskFiles, taskAttachmentUsesSsh } from '../../../../apps/desktop/src/lib/taskAttachmentTarget'

describe('task attachment SSH route', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.devices = []; mocks.items = []; mocks.hello = { protocol: 5 };
    mocks.cached = [{ device_id: 'host', is_online: true, capabilities: { remote_protocol: 16 } }] })
  it.each([4, null])('uses attachment capability 16 independently of hello %s', async protocol => {
    mocks.devices = [{ id: 'host', connectVia: 'ssh' }]
    mocks.hello = protocol === null ? null : { protocol }
    mocks.files.getAbsolutePath.mockResolvedValue({ success: true, data: { path: '/task-worktree' } })
    mocks.files.createEntry.mockResolvedValue({ success: true })
    mocks.upload.mockResolvedValue({ status: 'done', skipped: [] })
    const item = { segments: ['brief.txt'], size: 3, slice: async () => new Uint8Array(3) }
    await expect(pushTaskFiles({ deviceId: 'host', projectId: 'project', workspaceId: 'workspace', chatId: 'chat', owner: 'owner' }, 'item', [item])).resolves.toBe('.gugu/attachments/item')
    expect(mocks.upload).toHaveBeenCalledOnce()
  })
  it.each([15, undefined])('rejects SSH attachments before transferring when capability is %s', async protocol => {
    mocks.devices = [{ id: 'host', connectVia: 'ssh' }]
    mocks.cached = [{ device_id: 'host', is_online: true, capabilities: { remote_protocol: protocol } }]
    await expect(pushTaskFiles({ deviceId: 'host', projectId: 'project', workspaceId: 'workspace', chatId: 'chat', owner: 'owner' }, 'item', [])).rejects.toMatchObject({ code: 'host_update_required' })
    expect(mocks.files.getAbsolutePath).not.toHaveBeenCalled()
    expect(mocks.upload).not.toHaveBeenCalled()
  })
  it('rejects a reported old prefetch host before the request', async () => {
    mocks.cached = [{ device_id: 'host', is_online: true, capabilities: { remote_protocol: 15 } }]
    await expect(prefetchTaskFiles({ deviceId: 'host', sessionId: 's', chatId: 'chat', owner: 'owner' }, [])).rejects.toMatchObject({ code: 'host_update_required' })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it.each([16, 15])('checks the prefetch reply when desktop heartbeat capability is missing (reply=%s)', async protocol => {
    mocks.cached = []
    mocks.rpc.mockResolvedValue({ result: { protocol, value: [] } })
    const request = prefetchTaskFiles({ deviceId: 'host', sessionId: 's', chatId: 'chat', owner: 'owner' }, [])
    if (protocol === 16) await expect(request).resolves.toBeUndefined()
    else await expect(request).rejects.toMatchObject({ code: 'host_update_required' })
    expect(mocks.rpc).toHaveBeenCalledOnce()
  })
  it('leaves offline prefetch to delivery even when its cached capability is old', async () => {
    mocks.cached = [{ device_id: 'host', is_online: false, capabilities: { remote_protocol: 15 } }]
    await expect(prefetchTaskFiles({ deviceId: 'host', sessionId: 's', chatId: 'chat', owner: 'owner' }, [])).resolves.toBeUndefined()
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('never writes attachment bytes through a tunnel even when it supports direct terminals', async () => {
    mocks.devices = [{ id: 'host', connectVia: 'tunnel', directTerminal: true }]
    expect(taskAttachmentUsesSsh('host')).toBe(false)
    await expect(pushTaskFiles({ deviceId: 'host', projectId: 'project', workspaceId: 'workspace', chatId: 'chat', owner: 'owner' }, 'item', [])).rejects.toThrow('no SSH')
    expect(mocks.files.writeChunk).not.toHaveBeenCalled()
    expect(mocks.files.getAbsolutePath).not.toHaveBeenCalled()
    expect(mocks.upload).not.toHaveBeenCalled()
  })
  it('uses the existing workspace transfer and reports SSH failure without another route', async () => {
    mocks.devices = [{ id: 'host', connectVia: 'ssh' }]
    mocks.files.getAbsolutePath.mockResolvedValue({ success: true, data: { path: '/task-worktree' } })
    mocks.files.createEntry.mockResolvedValue({ success: true })
    mocks.upload.mockResolvedValue({ status: 'failed', skipped: [], error: new Error('SSH disconnected') })
    const item = { segments: ['brief.txt'], size: 3, slice: async () => new Uint8Array(3) }
    await expect(pushTaskFiles({ deviceId: 'host', projectId: 'project', workspaceId: 'workspace', chatId: 'chat', owner: 'owner' }, 'item', [item])).rejects.toThrow('SSH disconnected')
    expect(mocks.upload).toHaveBeenCalledWith('/task-worktree/.gugu/attachments', [{ ...item, segments: ['item', 'brief.txt'] }], 'item')
  })
  it('cancels the existing SSH transfer when its chip is removed', async () => {
    mocks.devices = [{ id: 'host', connectVia: 'ssh' }]
    mocks.files.getAbsolutePath.mockResolvedValue({ success: true, data: { path: '/task-worktree' } })
    mocks.files.createEntry.mockResolvedValue({ success: true })
    const controller = new AbortController()
    let started!: () => void
    const running = new Promise<void>(resolve => { started = resolve })
    const cancel = vi.fn()
    mocks.upload.mockImplementation(() => new Promise(resolve => {
      cancel.mockImplementation(() => resolve({ status: 'cancelled', skipped: [] }))
      mocks.items = [{ name: 'item', done: 0, status: 'running', cancel }]
      started()
    }))
    const result = pushTaskFiles({ deviceId: 'host', projectId: 'project', workspaceId: 'workspace', chatId: 'chat', owner: 'owner' }, 'item', [{ segments: ['large.bin'], size: 50 * 1024 * 1024, slice: async () => new Uint8Array() }], undefined, controller.signal)
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await running
    controller.abort()
    await rejected
    expect(cancel).toHaveBeenCalledOnce()
  })

})
