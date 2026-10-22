import { describe, expect, it, vi } from 'vitest'
import {
  listDeviceProjects,
  normalizeDeviceProjectRow,
  publishDeviceProjects,
  withDeviceProjects,
  type DeviceProject,
} from '../../../../packages/core/src/cloud/deviceProjects'
import { createDeviceProjectsPublisher, RETRY_MS, SETTLE_MS } from '../../../../packages/core/src/cloud/deviceProjectsPublisher'

// #113 项目记在账号上:每台机器整份记它的项目,别的端读账号上的那份。

const project = (overrides: Partial<DeviceProject> = {}): DeviceProject => ({
  localProjectId: 'p1',
  name: 'repo',
  rootPath: '/srv/repo',
  createdAt: '2026-10-01T08:00:00.000Z',
  chatId: 'chat-1',
  groupRepresentative: false,
  folders: [
    { workspaceId: 'ws-root', kind: 'root', path: '/srv/repo', attachedAt: null },
    { workspaceId: 'ws-wt', kind: 'attached', path: '/srv/repo-wt', attachedAt: '2026-10-02T00:00:00.000Z' },
  ],
  ...overrides,
})

const row = (overrides: Record<string, unknown> = {}) => ({
  device_id: 'dev-1',
  local_project_id: 'p1',
  name: 'repo',
  root_path: '/srv/repo',
  created_at: '2026-10-01T08:00:00+00:00',
  chat_id: 'chat-1',
  group_representative: false,
  folders: [
    { workspace_id: 'ws-root', kind: 'root', path: '/srv/repo', attached_at: null },
    { workspace_id: 'ws-wt', kind: 'attached', path: '/srv/repo-wt', attached_at: '2026-10-02T00:00:00.000Z' },
  ],
  ...overrides,
})

describe('publishDeviceProjects', () => {
  it('sends the whole set in the shape the database checks and reports whether it changed', async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }))
    await expect(publishDeviceProjects({ rpc }, 'dev-1', [project()])).resolves.toBe(true)
    expect(rpc).toHaveBeenCalledWith('publish_device_projects', {
      p_device_id: 'dev-1',
      p_projects: [{
        local_project_id: 'p1',
        name: 'repo',
        root_path: '/srv/repo',
        created_at: '2026-10-01T08:00:00.000Z',
        chat_id: 'chat-1',
        group_representative: false,
        folders: [
          { workspace_id: 'ws-root', kind: 'root', path: '/srv/repo', attached_at: null },
          { workspace_id: 'ws-wt', kind: 'attached', path: '/srv/repo-wt', attached_at: '2026-10-02T00:00:00.000Z' },
        ],
      }],
    })
    rpc.mockResolvedValueOnce({ data: false, error: null })
    await expect(publishDeviceProjects({ rpc }, 'dev-1', [project()])).resolves.toBe(false)
  })

  it('throws what the database refused', async () => {
    const rpc = async () => ({ data: null, error: { message: 'Device is not owned by current user' } })
    await expect(publishDeviceProjects({ rpc }, 'dev-x', [])).rejects.toThrow(/not owned/)
  })
})

describe('listDeviceProjects', () => {
  const client = (data: unknown, error: { message: string } | null = null) => {
    const eq = vi.fn(async () => ({ data, error }))
    const select = vi.fn(() => ({ eq }))
    return { client: { from: vi.fn(() => ({ select })) }, select, eq }
  }

  it('groups the rows by device, newest project first, only the owner’s rows', async () => {
    const { client: c, eq } = client([
      row(),
      row({ local_project_id: 'p2', created_at: '2026-10-05T00:00:00+00:00', chat_id: null, group_representative: true, folders: [] }),
      row({ device_id: 'dev-2', local_project_id: 'p9' }),
    ])
    const listed = await listDeviceProjects(c as never, 'owner-1')
    expect(eq).toHaveBeenCalledWith('user_id', 'owner-1')
    expect(Object.keys(listed).sort()).toEqual(['dev-1', 'dev-2'])
    expect(listed['dev-1']!.map((item) => item.localProjectId)).toEqual(['p2', 'p1'])
    expect(listed['dev-1']![0]).toMatchObject({ chatId: null, groupRepresentative: true, folders: [], createdAt: '2026-10-05T00:00:00.000Z' })
    expect(listed['dev-1']![1]).toEqual(project())
  })

  it('refuses to list without an owner, and fails as a whole on a row it cannot read (❌ quietly lists one project less)', async () => {
    await expect(listDeviceProjects(client([]).client as never, '')).rejects.toThrow(/ownerId/)
    await expect(listDeviceProjects(client(null, { message: 'permission denied' }).client as never, 'o')).rejects.toThrow(/permission denied/)
    await expect(listDeviceProjects(client([row({ folders: 'x' })]).client as never, 'o')).rejects.toThrow(/folder list/)
  })

  it('reads a row strictly: every field the machine wrote must be there', () => {
    expect(() => normalizeDeviceProjectRow(row({ root_path: '' }))).toThrow(/root_path/)
    expect(() => normalizeDeviceProjectRow(row({ created_at: 'soon' }))).toThrow(/created_at/)
    expect(() => normalizeDeviceProjectRow(row({ folders: [{ workspace_id: 'w', kind: 'other', path: '/x' }] }))).toThrow(/kind/)
    expect(() => normalizeDeviceProjectRow(row({ name: null }))).toThrow(/name/)
    // 名字可以是空串(那台机器上就叫这个)。
    expect(normalizeDeviceProjectRow(row({ name: '' })).project.name).toBe('')
  })
})

describe('withDeviceProjects', () => {
  const devices = [{ device_id: 'dev-1' }, { device_id: 'dev-2' }]

  it('a fresh read: every device gets its projects, a device with none gets an empty list', () => {
    expect(withDeviceProjects(devices, { 'dev-1': [project()] }, [])).toEqual([
      { device_id: 'dev-1', projects: [project()] },
      { device_id: 'dev-2', projects: [] },
    ])
  })

  it('a failed read keeps what each device had; a device never read stays without it', () => {
    const previous = [{ device_id: 'dev-1', projects: [project()] }]
    expect(withDeviceProjects(devices, null, previous)).toEqual([{ device_id: 'dev-1', projects: [project()] }, { device_id: 'dev-2' }])
  })
})

describe('createDeviceProjectsPublisher', () => {
  function harness(overrides: { auth?: () => Promise<{ accessToken: string; userId: string } | null> } = {}) {
    const timers: { run: () => void; ms: number }[] = []
    const rpc = vi.fn(async () => ({ data: true as unknown, error: null as { message: string } | null }))
    const records = vi.fn(async () => [project()])
    const warn = vi.fn()
    const publisher = createDeviceProjectsPublisher({
      getAuth: overrides.auth ?? (async () => ({ accessToken: 'token', userId: 'u1' })),
      deviceId: async () => 'dev-1',
      client: () => ({ rpc }),
      records,
      warn,
      setTimeout: (run, ms) => {
        const timer = { run, ms }
        timers.push(timer)
        return timer
      },
      clearTimeout: (handle) => {
        const index = timers.indexOf(handle as never)
        if (index >= 0) timers.splice(index, 1)
      },
    })
    const fire = async () => {
      const timer = timers.shift()
      if (!timer) throw new Error('no timer pending')
      timer.run()
      await vi.waitFor(() => expect(records.mock.calls.length + warn.mock.calls.length).toBeGreaterThan(0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    return { publisher, timers, rpc, records, warn, fire }
  }

  it('settles a burst of changes into one publish', async () => {
    const { publisher, timers, rpc, fire } = harness()
    publisher.notify()
    publisher.notify()
    publisher.notify()
    expect(timers.map((timer) => timer.ms)).toEqual([SETTLE_MS])
    await fire()
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(timers).toEqual([])
  })

  it('retries a failed publish until it lands; a new change does not wait out the retry', async () => {
    const { publisher, timers, rpc, warn, fire } = harness()
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'network down' } })
    publisher.notify()
    await fire()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('publish failed'), expect.objectContaining({ error: 'network down' }))
    expect(timers.map((timer) => timer.ms)).toEqual([RETRY_MS])
    publisher.notify()
    expect(timers.map((timer) => timer.ms)).toEqual([SETTLE_MS])
    await fire()
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(timers).toEqual([])
  })

  it('a change during a publish is published again right after', async () => {
    const { publisher, timers, rpc, records } = harness()
    const gate = Promise.withResolvers<DeviceProject[]>()
    records.mockReturnValueOnce(gate.promise)
    publisher.notify()
    timers.shift()!.run()
    await vi.waitFor(() => expect(records).toHaveBeenCalledTimes(1))
    publisher.notify()
    gate.resolve([project()])
    await vi.waitFor(() => expect(timers.map((timer) => timer.ms)).toEqual([SETTLE_MS]))
    timers.shift()!.run()
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2))
  })

  it('does nothing while signed out (signing in notifies again)', async () => {
    const auth = vi.fn(async () => null)
    const { publisher, rpc, records, timers } = harness({ auth })
    publisher.notify()
    timers.shift()!.run()
    await vi.waitFor(() => expect(auth).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(records).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
    expect(timers).toEqual([])
  })

  it('a machine whose projects cannot be read is retried, ❌ published as an empty list', async () => {
    const { publisher, timers, rpc, records, warn, fire } = harness()
    records.mockRejectedValueOnce(new Error('project group bindings unavailable'))
    publisher.notify()
    await fire()
    expect(rpc).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    expect(timers.map((timer) => timer.ms)).toEqual([RETRY_MS])
  })

  it('stop() cancels what is pending', () => {
    const { publisher, timers } = harness()
    publisher.notify()
    publisher.stop()
    expect(timers).toEqual([])
    publisher.notify()
    expect(timers).toEqual([])
  })
})
